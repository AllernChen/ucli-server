import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { resolveChannelCost } from '../../../packages/gateway-core/src/cost-schedule.js'
import {
  CatalogLifecycle, CreateModelPriceDto, CreatePublicModelDto, UpdateModelPriceDto, UpdatePublicModelDto
} from './catalog.dto.js'
import { ChannelModelsService, type CreateChannelModelInput } from './channel-models.service.js'
import { normalizeManufacturer } from './model-manufacturer.js'
import { lockCatalogRecord } from './catalog-lock.js'

type CreateAbilityInput = Omit<CreateChannelModelInput, 'publicModelId'> & { channelId: string }
type ArchiveAbilityInput = Pick<CreateAbilityInput, 'channelId' | 'protocol'>

@Injectable()
export class ModelsService {
  constructor(private readonly prisma: PrismaService, private readonly channelModels: ChannelModelsService) {}

  async list(lifecycle: CatalogLifecycle = CatalogLifecycle.ACTIVE) {
    const now = new Date()
    const childWhere = lifecycleWhere(lifecycle)
    const [models, usage] = await Promise.all([
      this.prisma.publicModel.findMany({ where: lifecycleWhere(lifecycle), include: {
        channelModels: { where: childWhere, include: {
          channel: { select: { costTimezone: true } },
          costRules: { where: { ...childWhere, ...(lifecycle === CatalogLifecycle.ACTIVE ? { enabled: true } : {}) } }
        } },
        prices: { where: childWhere, orderBy: { validFrom: 'desc' } }
      } }),
      this.prisma.usageLog.groupBy({ by: ['publicModelId'], where: { startedAt: { gte: new Date(now.getTime() - 86_400_000) } },
        _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, costUsd: true } })
    ])
    const priceIds = models.flatMap(model => model.prices.map(price => price.id))
    const priceUsage = priceIds.length
      ? await this.prisma.usageLog.groupBy({ by: ['priceVersionId'], where: { priceVersionId: { in: priceIds } } })
      : []
    const usageByModel = new Map(usage.map(item => [item.publicModelId, item]))
    const usedPriceIds = new Set(priceUsage.flatMap(item => item.priceVersionId ? [item.priceVersionId] : []))
    return models.map(({ channelModels, ...model }) => {
      const fallback = model.prices.find(price => price.enabled && price.validFrom <= now && (!price.validUntil || price.validUntil > now))
      const abilities = channelModels.map(({ channel, ...ability }) => {
        let currentCost: any = null
        try { currentCost = resolveChannelCost(ability.costRules.map(rule => ({
          ...rule, inputPerMillion: rule.inputPerMillion.toString(), outputPerMillion: rule.outputPerMillion.toString(),
          cachedPerMillion: rule.cachedPerMillion.toString(), reasoningPerMillion: rule.reasoningPerMillion.toString()
        })), now, channel.costTimezone) } catch { /* Invalid legacy rule is unavailable, not fatal to the catalog. */ }
        if (!currentCost && fallback && lifecycle === CatalogLifecycle.ACTIVE) currentCost = {
          id: fallback.id, source: 'PUBLIC_MODEL_FALLBACK', inputPerMillion: fallback.inputPerMillion.toString(),
          outputPerMillion: fallback.outputPerMillion.toString(), cachedPerMillion: fallback.cachedPerMillion.toString(),
          reasoningPerMillion: fallback.reasoningPerMillion.toString(), currency: fallback.currency, timezone: channel.costTimezone,
          resolvedAt: now.toISOString()
        }
        return { ...ability, costTimezone: channel.costTimezone, currentCost }
      })
      const aggregate = usageByModel.get(model.id)
      return { ...model, prices: model.prices.map(price => ({ ...price, used: usedPriceIds.has(price.id) })), abilities, usage24h: {
        requests: aggregate?._count._all || 0,
        tokens: Number(aggregate?._sum.inputTokens || 0) + Number(aggregate?._sum.outputTokens || 0),
        costUsd: aggregate?._sum.costUsd?.toString() || '0'
      } }
    })
  }

  async create(input: CreatePublicModelDto) {
    const existing = await this.prisma.publicModel.findUnique({ where: { id: input.id } })
    if (existing) throw new ConflictException(existing.deletedAt
      ? 'Public model is archived; restore it instead'
      : 'Public model already exists')
    const manufacturer = normalizeManufacturer(input.manufacturer)
    return this.prisma.publicModel.create({ data: {
      id: input.id, displayName: input.displayName, ...manufacturer,
      contextSize: input.contextSize ?? null, enabled: false
    } })
  }

  async update(id: string, input: UpdatePublicModelDto) {
    await this.requireActiveModel(id)
    const manufacturer = input.manufacturer === undefined ? {} : normalizeManufacturer(input.manufacturer)
    return this.prisma.publicModel.update({ where: { id }, data: {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...manufacturer,
      ...(input.contextSize !== undefined ? { contextSize: input.contextSize ?? null } : {})
    } })
  }

  async archive(id: string) {
    return this.prisma.$transaction(async transaction => {
      await lockCatalogRecord(transaction, `public-model:${id}`)
      const model = await transaction.publicModel.findUnique({ where: { id } })
      if (!model) throw new NotFoundException('Public model not found')
      if (model.deletedAt) return { id, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt: model.deletedAt }
      const deletedAt = new Date()
      const modelIds = (await transaction.channelModel.findMany({ where: { publicModelId: id }, select: { id: true } })).map(item => item.id)
      await transaction.channelModelCostRule.updateMany({
        where: { channelModelId: { in: modelIds } }, data: { deletedAt, enabled: false }
      })
      await transaction.channelModel.updateMany({
        where: { publicModelId: id }, data: { deletedAt, enabled: false, probeEnabled: false, health: 'DISABLED' }
      })
      await transaction.modelPriceVersion.updateMany({ where: { publicModelId: id }, data: { deletedAt, enabled: false } })
      await transaction.publicModel.update({ where: { id }, data: { deletedAt, enabled: false } })
      return { id, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt }
    })
  }

  async restore(id: string) {
    const model = await this.prisma.publicModel.findUnique({ where: { id } })
    if (!model) throw new NotFoundException('Public model not found')
    if (!model.deletedAt) return { id, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
    await this.prisma.publicModel.update({ where: { id }, data: { deletedAt: null, enabled: false } })
    return { id, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
  }

  async publish(id: string) {
    const check = await this.publishCheck(id)
    if (!check.ready) throw new BadRequestException({ message: 'Model is not ready to publish', blockers: check.blockers })
    return this.prisma.publicModel.update({ where: { id }, data: { enabled: true } })
  }

  async unpublish(id: string) {
    await this.requireActiveModel(id)
    return this.prisma.publicModel.update({ where: { id }, data: { enabled: false } })
  }

  async publishCheck(id: string) {
    const model = await this.requireActiveModel(id)
    const check = await this.channelModels.publishCheck(id)
    const blockers: string[] = [...check.blockers]
    const contextSize = model.contextSize
    if (typeof contextSize !== 'number' || !Number.isSafeInteger(contextSize) || contextSize <= 0) {
      blockers.push('MODEL_CONTEXT_SIZE_REQUIRED')
    }
    return { ...check, ready: blockers.length === 0, blockers }
  }

  async createAbility(id: string, input: CreateAbilityInput) {
    await this.requireActiveModel(id)
    const { channelId, ...mapping } = input
    return this.channelModels.create(channelId, { ...mapping, publicModelId: id })
  }

  async archiveAbility(id: string, input: ArchiveAbilityInput) {
    await this.requireActiveModel(id)
    const ability = await this.prisma.channelModel.findUnique({ where: { channelId_publicModelId_protocol: {
      channelId: input.channelId, publicModelId: id, protocol: input.protocol
    } } })
    if (!ability) throw new NotFoundException('Channel model not found')
    return this.channelModels.archive(ability.id)
  }

  async createPrice(id: string, input: CreateModelPriceDto) {
    await this.requireActiveModel(id)
    const range = validatedPriceRange(input.validFrom, input.validUntil)
    return this.prisma.modelPriceVersion.create({ data: {
      publicModelId: id, inputPerMillion: requiredAmount(input.inputPerMillion, 'inputPerMillion'),
      outputPerMillion: requiredAmount(input.outputPerMillion, 'outputPerMillion'),
      cachedPerMillion: input.cachedPerMillion || '0', reasoningPerMillion: input.reasoningPerMillion || '0',
      currency: input.currency || 'CNY', validFrom: range.validFrom, validUntil: range.validUntil
    } })
  }

  async updatePrice(id: string, priceId: string, input: UpdateModelPriceDto) {
    await this.requireActiveModel(id)
    const price = await this.requirePrice(id, priceId)
    if (price.deletedAt) throw new ConflictException('Archived price cannot be edited')
    const used = await this.prisma.usageLog.count({ where: { priceVersionId: priceId } })
    if (used) throw new ConflictException('Used price versions are immutable; create a new version instead')
    const range = validatedPriceRange(
      input.validFrom ?? price.validFrom.toISOString(),
      input.validUntil !== undefined ? input.validUntil : price.validUntil?.toISOString() || null
    )
    return this.prisma.modelPriceVersion.update({ where: { id: priceId }, data: {
      ...(input.inputPerMillion !== undefined ? { inputPerMillion: input.inputPerMillion } : {}),
      ...(input.outputPerMillion !== undefined ? { outputPerMillion: input.outputPerMillion } : {}),
      ...(input.cachedPerMillion !== undefined ? { cachedPerMillion: input.cachedPerMillion } : {}),
      ...(input.reasoningPerMillion !== undefined ? { reasoningPerMillion: input.reasoningPerMillion } : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      ...(input.validFrom !== undefined ? { validFrom: range.validFrom } : {}),
      ...(input.validUntil !== undefined ? { validUntil: range.validUntil } : {})
    } })
  }

  async archivePrice(id: string, priceId: string) {
    await this.requireActiveModel(id)
    const price = await this.requirePrice(id, priceId)
    if (price.deletedAt) return { id: priceId, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt: price.deletedAt }
    const deletedAt = new Date()
    await this.prisma.modelPriceVersion.update({ where: { id: priceId }, data: { deletedAt, enabled: false } })
    return { id: priceId, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt }
  }

  async restorePrice(id: string, priceId: string) {
    await this.requireActiveModel(id)
    const price = await this.requirePrice(id, priceId)
    if (!price.deletedAt) return { id: priceId, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
    await this.prisma.modelPriceVersion.update({ where: { id: priceId }, data: { deletedAt: null, enabled: false } })
    return { id: priceId, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
  }

  async setPriceEnabled(id: string, priceId: string, enabled: boolean) {
    await this.requireActiveModel(id)
    const price = await this.requirePrice(id, priceId)
    if (price.deletedAt) throw new ConflictException('Archived price cannot be activated')
    if (enabled && price.currency !== 'CNY') {
      throw new ConflictException('Legacy-currency prices cannot be activated; create a new CNY price instead')
    }
    return this.prisma.modelPriceVersion.update({ where: { id: priceId }, data: { enabled } })
  }

  private async requireActiveModel(id: string) {
    const model = await this.prisma.publicModel.findUnique({ where: { id } })
    if (!model || model.deletedAt) throw new NotFoundException('Public model not found')
    return model
  }

  private async requirePrice(publicModelId: string, id: string) {
    const price = await this.prisma.modelPriceVersion.findFirst({ where: { id, publicModelId } })
    if (!price) throw new NotFoundException('Model price not found')
    return price
  }
}

function lifecycleWhere(lifecycle: CatalogLifecycle): Record<string, unknown> {
  if (lifecycle === CatalogLifecycle.ALL) return {}
  return lifecycle === CatalogLifecycle.ARCHIVED ? { deletedAt: { not: null } } : { deletedAt: null }
}

function requiredAmount(value: string | undefined, field: string): string {
  if (value === undefined) throw new BadRequestException(`${field} is required`)
  return value
}

function validatedPriceRange(validFrom?: string, validUntil?: string | null) {
  const from = new Date(validFrom || Date.now())
  const until = validUntil ? new Date(validUntil) : null
  if (!Number.isFinite(from.getTime()) || (until && (!Number.isFinite(until.getTime()) || until <= from))) {
    throw new BadRequestException('Model price validity range is invalid')
  }
  return { validFrom: from, validUntil: until }
}
