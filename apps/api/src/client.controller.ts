import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard, authorizationFailure } from '../../../packages/security/src/auth.js'
import { ModelCatalogService } from '../../../packages/gateway-core/src/model-catalog.service.js'
import { deviceGrantFailure } from '../../../packages/security/src/device-grants.js'

@ApiTags('client') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/client')
export class ClientController {
  constructor(private readonly prisma: PrismaService, private readonly catalog: ModelCatalogService = new ModelCatalogService(prisma)) {}
  @Get('bootstrap') @Header('Cache-Control', 'no-store') async bootstrap(@Req() request: any) {
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
      this.catalog.list({ organizationId: request.principal.organizationId, accountId: request.principal.sub,
        role: request.principal.role, groupId: request.principal.groupId })
    ])
    return {
      organization: { id: organization.id, name: organization.name, timezone: organization.timezone },
      gateway: { baseUrl: process.env.GATEWAY_PUBLIC_URL || 'http://localhost:3001' },
      models,
      skillsCatalogUrl: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/v1/skills/catalog`,
      ...(device?.grant ? { authorization: {
        expiresAt: device.grant.expiresAt?.toISOString() ?? null, serverTime: now.toISOString()
      } } : {})
    }
  }
}
