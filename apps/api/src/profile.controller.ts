import { Controller, ForbiddenException, Get, Header, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard, type AuthPrincipal } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { ModelCatalogService } from '../../../packages/gateway-core/src/model-catalog.service.js'
import { AnalyticsQueryDto } from './analytics.dto.js'
import { ProfileUsageService } from './profile-usage.service.js'

type AuthRequest = { principal: AuthPrincipal }

@ApiTags('profile') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/me/profile')
export class ProfileController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: ModelCatalogService,
    private readonly profileUsage: ProfileUsageService
  ) {}

  @Get('usage-groups') @Header('Cache-Control', 'no-store')
  async groups(@Req() request: AuthRequest) {
    const actor = this.webActor(request.principal)
    const items = await this.prisma.groupMember.findMany({ where: { organizationId: actor.organizationId, accountId: actor.sub, removedAt: null },
      select: { joinedAt: true, group: { select: { id: true, name: true, type: true, enabled: true, archivedAt: true } } },
      orderBy: { group: { name: 'asc' } } })
    return items.map(({ joinedAt, group }) => ({ id: group.id, name: group.name, type: group.type,
      enabled: group.enabled, archivedAt: group.archivedAt, joinedAt }))
  }

  @Get('usage-groups/:id/models') @Header('Cache-Control', 'no-store')
  async models(@Req() request: AuthRequest, @Param('id', UuidPipe) groupId: string) {
    const actor = this.webActor(request.principal)
    return this.catalog.list({ organizationId: actor.organizationId, accountId: actor.sub, role: actor.role, groupId })
  }

  @Get('usage') @Header('Cache-Control', 'no-store')
  async usage(@Req() request: AuthRequest, @Query() query: AnalyticsQueryDto) {
    const actor = this.webActor(request.principal)
    return this.profileUsage.summary(actor, query)
  }

  private webActor(actor: AuthPrincipal) {
    if (actor.deviceId) throw new ForbiddenException('Web login required')
    return actor
  }
}
