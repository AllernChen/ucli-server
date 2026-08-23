import { Controller, Get, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { canAccessModel } from '../../../packages/gateway-core/src/access-policy.js'

@ApiTags('client') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/client')
export class ClientController {
  constructor(private readonly prisma: PrismaService) {}
  @Get('bootstrap') async bootstrap(@Req() request: any) {
    const [organization, models] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: request.principal.organizationId } }),
      this.prisma.publicModel.findMany({ where: { enabled: true, deletedAt: null }, include: { policies: true } })
    ])
    return {
      organization: { id: organization.id, name: organization.name, timezone: organization.timezone },
      gateway: { baseUrl: process.env.GATEWAY_PUBLIC_URL || 'http://localhost:3001' },
      models: models.filter(model => canAccessModel(model.policies, { organizationId: request.principal.organizationId,
        accountId: request.principal.sub, role: request.principal.role }))
        .map(({ id, displayName, contextSize }) => ({ id, displayName, contextSize })),
      skillsCatalogUrl: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/v1/skills/catalog`
    }
  }
}
