import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../database/src/prisma.service.js'
import { assertActiveGroupMember } from '../../security/src/group-access.js'
import { canAccessGroupModel, canAccessModel, type ModelAccessPolicy, type ModelAccessPrincipal } from './access-policy.js'
import { configuredClientProtocols } from './model-capabilities.js'
import type { GatewayProtocol } from './protocol.js'

export const modelCapabilitiesSelect = Prisma.validator<Prisma.ChannelModelSelect>()({
  protocol: true, enabled: true, deletedAt: true,
  channel: { select: { enabled: true, deletedAt: true, keys: { select: { enabled: true, deletedAt: true } } } }
})

@Injectable()
export class ModelCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  private async allowedModels(identity: ModelAccessPrincipal): Promise<string[] | null> {
    if (!identity.groupId) return null
    const member = await assertActiveGroupMember(this.prisma, { ...identity, groupId: identity.groupId })
    return member.group.models.map(item => item.publicModelId)
  }

  async list(identity: ModelAccessPrincipal, protocol?: GatewayProtocol) {
    const allowed = await this.allowedModels(identity)
    const models = await this.prisma.publicModel.findMany({
      where: { enabled: true, deletedAt: null, contextSize: { gt: 0 } },
      include: { policies: true, channelModels: { select: modelCapabilitiesSelect } }, orderBy: { id: 'asc' }
    })
    return models.filter(model => canAccessModel(model.policies, identity) && canAccessGroupModel(model.id, allowed))
      .map(({ id, displayName, contextSize, channelModels }) => ({
        id, displayName, contextSize, protocols: configuredClientProtocols(channelModels)
      })).filter(model => model.protocols.length > 0 && (!protocol || model.protocols.includes(protocol)))
  }

  async assertAllowed(identity: ModelAccessPrincipal, model: { id: string; policies: ModelAccessPolicy[] } | null) {
    if (!model || !canAccessModel(model.policies, identity)) throw new NotFoundException('Model is unavailable')
    if (!canAccessGroupModel(model.id, await this.allowedModels(identity))) {
      throw new ForbiddenException({ code: 'model_access_denied', message: 'Model is not permitted for this group' })
    }
  }
}
