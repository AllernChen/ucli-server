import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { FileInterceptor } from '@nestjs/platform-express'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import type { Response } from 'express'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { scanSkillEntries } from '../../../packages/skills/src/archive-scan.js'
import { ObjectStorageService } from '../../../packages/storage/src/object-storage.js'

@ApiTags('skills') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/skills')
export class SkillsController {
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService) {}
  @Get('catalog') async catalog(@Req() request: any, @Query('cursor') cursor?: string) {
    const versions = await this.prisma.skillVersion.findMany({ where: {
      status: 'PUBLISHED', ...(cursor ? { createdAt: { gt: new Date(cursor) } } : {}),
      OR: [{ visibility: 'GLOBAL' }, { organizations: { some: { organizationId: request.principal.organizationId } } }]
    }, include: { skill: true }, orderBy: { createdAt: 'asc' }, take: 100 })
    return versions.map(version => ({
      id: version.id, version: version.version, sha256: version.sha256, sizeBytes: version.sizeBytes,
      publishedAt: version.publishedAt, createdAt: version.createdAt,
      skill: { slug: version.skill.slug, name: version.skill.name, description: version.skill.description },
      downloadUrl: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/v1/skills/${version.id}/download`
    }))
  }
  @Get('revocations') revocations(@Req() request: any) {
    return this.prisma.skillVersion.findMany({
      where: {
        status: { in: ['REVOKED', 'DEPRECATED'] },
        OR: [{ visibility: 'GLOBAL' }, { organizations: { some: { organizationId: request.principal.organizationId } } }]
      },
      select: { id: true, version: true, status: true, skill: { select: { slug: true, name: true } } },
      orderBy: { createdAt: 'desc' }
    })
  }
  @Roles('PLATFORM_ADMIN') @Get('admin') list() {
    return this.prisma.skill.findMany({ include: { versions: true }, orderBy: { createdAt: 'desc' } })
  }
  @Roles('PLATFORM_ADMIN') @Post('admin') create(@Body() body: any) {
    return this.prisma.skill.create({ data: { slug: body.slug, name: body.name, description: body.description } })
  }
  @Roles('PLATFORM_ADMIN') @Post('admin/:id/versions') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async version(@Param('id', UuidPipe) id: string, @Body() body: any, @UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException('ZIP file is required')
    const zip = new AdmZip(file.buffer)
    const scanned = scanSkillEntries(zip.getEntries().filter(entry => !entry.isDirectory).map(entry => ({
      name: entry.entryName, size: entry.header.size, content: entry.getData(), symbolicLink: (entry.header.attr >>> 16 & 0o170000) === 0o120000
    })))
    const sha256 = createHash('sha256').update(file.buffer).digest('hex')
    const objectKey = `skills/${id}/${body.version}/${sha256}.zip`
    await this.storage.put(objectKey, file.buffer)
    const organizationIds = body.organizationIds ? JSON.parse(body.organizationIds) : []
    return this.prisma.skillVersion.create({ data: {
      skillId: id, version: body.version, objectKey, sha256, sizeBytes: file.buffer.length,
      manifest: scanned.manifest, fileManifest: scanned.files, scanResult: { safe: true, totalBytes: scanned.totalBytes },
      visibility: organizationIds.length ? 'ORGANIZATIONS' : 'GLOBAL',
      organizations: organizationIds.length ? { create: organizationIds.map((organizationId: string) => ({ organizationId })) } : undefined
    } })
  }
  @Roles('PLATFORM_ADMIN') @Post('admin/:id/publish') async publish(@Param('id', UuidPipe) id: string) {
    const version = await this.prisma.skillVersion.findUniqueOrThrow({ where: { id } })
    const scan = version.scanResult as any
    if (scan?.safe !== true) throw new BadRequestException('Skill scan has not passed')
    return this.prisma.skillVersion.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date() } })
  }
  @Roles('PLATFORM_ADMIN') @Post('admin/:id/revoke') revoke(@Param('id', UuidPipe) id: string) {
    return this.prisma.skillVersion.update({ where: { id }, data: { status: 'REVOKED' } })
  }
  @Get(':id/download') async download(@Param('id', UuidPipe) id: string, @Req() request: any, @Res() response: Response) {
    const version = await this.prisma.skillVersion.findFirst({ where: {
      id, status: 'PUBLISHED', OR: [{ visibility: 'GLOBAL' }, { organizations: { some: { organizationId: request.principal.organizationId } } }]
    } })
    if (!version) return response.status(404).json({ message: 'Skill version not found' })
    response.setHeader('content-type', 'application/zip')
    response.setHeader('x-ucli-sha256', version.sha256)
    ;(await this.storage.get(version.objectKey)).pipe(response)
  }
}
