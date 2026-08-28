import { Controller, Get, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard, authorizationFailure } from '../../../packages/security/src/auth.js'
import { canAccessModel } from '../../../packages/gateway-core/src/access-policy.js'
import { deviceGrantFailure } from '../../../packages/security/src/device-grants.js'
import { configuredClientProtocols } from '../../../packages/gateway-core/src/model-capabilities.js'

@ApiTags('client') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/client')
export class ClientController {
  constructor(private readonly prisma: PrismaService) {}
  @Get('bootstrap') async bootstrap(@Req() request: any) {
    const device = request.principal.deviceId ? await this.prisma.device.findFirst({
      where: { id: request.principal.deviceId, accountId: request.principal.sub, organizationId: request.principal.organizationId },
      include: { grant: true }
    }) : null
    if (request.principal.deviceId && !device) throw authorizationFailure('invalid_device')
    if (device && !device.grant) throw authorizationFailure('invalid_grant')
    const now = new Date()
    const failure = device?.grant && deviceGrantFailure(device.grant, now)
    if (failure) throw authorizationFailure(failure)
    const [organization, models] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: request.principal.organizationId } }),
      this.prisma.publicModel.findMany({
        where: { enabled: true, deletedAt: null, contextSize: { gt: 0 } },
        include: {
          policies: true,
          channelModels: { select: {
            protocol: true, enabled: true, deletedAt: true,
            channel: { select: {
              enabled: true, deletedAt: true,
              keys: { select: { enabled: true, deletedAt: true } }
            } }
          } }
        }
      })
    ])
    return {
      organization: { id: organization.id, name: organization.name, timezone: organization.timezone },
      gateway: { baseUrl: process.env.GATEWAY_PUBLIC_URL || 'http://localhost:3001' },
      models: models.filter(model => canAccessModel(model.policies, { organizationId: request.principal.organizationId,
        accountId: request.principal.sub, role: request.principal.role }))
        .map(({ id, displayName, contextSize, channelModels }) => ({
          id, displayName, contextSize, protocols: configuredClientProtocols(channelModels)
        }))
        .filter(model => model.protocols.length > 0),
      skillsCatalogUrl: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/v1/skills/catalog`,
      ...(device?.grant ? { authorization: {
        expiresAt: device.grant.expiresAt?.toISOString() ?? null, serverTime: now.toISOString()
      } } : {})
    }
  }
}
