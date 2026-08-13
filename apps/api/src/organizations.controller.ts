import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'

@ApiTags('admin/organizations') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/admin/organizations')
export class OrganizationsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.organization.findMany({ include: { _count: { select: { memberships: true, devices: true } } } }) }
  @Post() create(@Body() body: any) { return this.prisma.organization.create({ data: {
    name: body.name, slug: body.slug, timezone: body.timezone || 'UTC'
  } }) }
  @Patch(':id') update(@Param('id', UuidPipe) id: string, @Body() body: any) { return this.prisma.organization.update({
    where: { id }, data: { name: body.name, timezone: body.timezone, enabled: body.enabled }
  }) }
}
