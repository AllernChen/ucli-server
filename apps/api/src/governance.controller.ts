import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { randomBytes } from 'node:crypto'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { hashOpaqueToken } from '../../../packages/security/src/tokens.js'

@ApiTags('governance') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/admin')
export class GovernanceController {
  constructor(private readonly prisma: PrismaService) {}
  @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Get('members') members(@Req() request: any) {
    return this.prisma.membership.findMany({ where: { organizationId: request.principal.organizationId },
      include: { account: { select: { id: true, email: true, displayName: true, status: true, createdAt: true } } } })
  }
  @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Post('invitations') async invite(@Req() request: any, @Body() body: any) {
    const token = randomBytes(32).toString('base64url')
    const role = body.role === 'ORG_ADMIN' && request.principal.role !== 'MEMBER' ? 'ORG_ADMIN' : 'MEMBER'
    const invitation = await this.prisma.invitation.create({ data: {
      organizationId: request.principal.organizationId, email: String(body.email).toLowerCase(), role,
      tokenHash: hashOpaqueToken(token), expiresAt: new Date(Date.now() + 7 * 86_400_000), invitedById: request.principal.sub
    } })
    return { id: invitation.id, token, expiresAt: invitation.expiresAt }
  }
  @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Get('devices') devices(@Req() request: any) {
    return this.prisma.device.findMany({ where: { organizationId: request.principal.organizationId },
      select: { id: true, accountId: true, name: true, revokedAt: true, lastSeenAt: true, createdAt: true } })
  }
  @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Post('devices/:id/revoke') revoke(@Req() request: any, @Param('id', UuidPipe) id: string) {
    return this.prisma.device.updateMany({ where: { id, organizationId: request.principal.organizationId }, data: { revokedAt: new Date() } })
  }
  @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Get('quotas') quotas(@Req() request: any) {
    return this.prisma.quotaPolicy.findMany({ where: request.principal.role === 'PLATFORM_ADMIN' ? {} : { organizationId: request.principal.organizationId } })
  }
  @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Get('audit') audit(@Req() request: any, @Query('limit') limit?: string) {
    const where = request.principal.role === 'PLATFORM_ADMIN' ? {} : { organizationId: request.principal.organizationId }
    return this.prisma.auditLog.findMany({
      where, orderBy: { occurredAt: 'desc' }, take: Math.min(Number(limit) || 50, 200),
      include: { actor: { select: { email: true, displayName: true } } }
    })
  }
  @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Post('quotas') quota(@Req() request: any, @Body() body: any) {
    const organizationId = request.principal.role === 'PLATFORM_ADMIN' && body.organizationId
      ? body.organizationId : request.principal.organizationId
    return this.prisma.quotaPolicy.create({ data: {
      organizationId, accountId: body.accountId || null, publicModelId: body.publicModelId || null,
      dailyTokens: body.dailyTokens ? BigInt(body.dailyTokens) : null, monthlyTokens: body.monthlyTokens ? BigInt(body.monthlyTokens) : null,
      dailyCostUsd: body.dailyCostUsd || null, monthlyCostUsd: body.monthlyCostUsd || null,
      qps: body.qps || null, tpm: body.tpm ? BigInt(body.tpm) : null, concurrency: body.concurrency || null
    } })
  }
  @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Patch('quotas/:id') updateQuota(@Req() request: any, @Param('id', UuidPipe) id: string, @Body() body: any) {
    const where: any = { id, ...(request.principal.role === 'PLATFORM_ADMIN' ? {} : { organizationId: request.principal.organizationId }) }
    return this.prisma.quotaPolicy.updateMany({ where, data: {
      ...(body.dailyTokens !== undefined ? { dailyTokens: body.dailyTokens ? BigInt(body.dailyTokens) : null } : {}),
      ...(body.monthlyTokens !== undefined ? { monthlyTokens: body.monthlyTokens ? BigInt(body.monthlyTokens) : null } : {}),
      ...(body.dailyCostUsd !== undefined ? { dailyCostUsd: body.dailyCostUsd || null } : {}),
      ...(body.monthlyCostUsd !== undefined ? { monthlyCostUsd: body.monthlyCostUsd || null } : {}),
      ...(body.qps !== undefined ? { qps: body.qps || null } : {}),
      ...(body.tpm !== undefined ? { tpm: body.tpm ? BigInt(body.tpm) : null } : {}),
      ...(body.concurrency !== undefined ? { concurrency: body.concurrency || null } : {})
    } })
  }
  @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Delete('quotas/:id') deleteQuota(@Req() request: any, @Param('id', UuidPipe) id: string) {
    return this.prisma.quotaPolicy.deleteMany({ where: {
      id, ...(request.principal.role === 'PLATFORM_ADMIN' ? {} : { organizationId: request.principal.organizationId })
    } })
  }
}
