import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import {
  costRulesOverlap, resolveChannelCost, validateScheduledCost, type ScheduledCost
} from '../../../packages/gateway-core/src/cost-schedule.js'
import { selectKey } from '../../../packages/gateway-core/src/routing.js'
import { CatalogLifecycle } from './catalog.dto.js'

export interface PageRequest { limit: number; offset: number; lifecycle?: CatalogLifecycle }

export interface CreateChannelModelCostRuleInput {
  name: string
  daysOfWeek: number[]
  startMinute: number
  endMinute: number
  priority: number
  inputPerMillion: string
  outputPerMillion: string
  cachedPerMillion: string
  reasoningPerMillion: string
  validFrom: string
  validUntil?: string | null
}
export type UpdateChannelModelCostRuleInput = Partial<CreateChannelModelCostRuleInput> & { enabled?: boolean }
export type PreviewChannelModelCostRuleInput = CreateChannelModelCostRuleInput & { id?: string }

export interface CreateChannelModelInput {
  publicModelId: string
  upstreamModel: string
  protocol: 'OPENAI_RESPONSES' | 'OPENAI_CHAT' | 'ANTHROPIC_MESSAGES' | 'GEMINI'
  supportsStream: boolean
  supportsTools: boolean
  probeEnabled: boolean
  probeIntervalMinutes: number
}
export type UpdateChannelModelInput = Partial<Omit<CreateChannelModelInput, 'publicModelId' | 'protocol'>> & {
  enabled?: boolean
  health?: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'DISABLED'
}

@Injectable()
export class ChannelModelsService {
  constructor(private readonly prisma: PrismaService) {}

  async listByChannel(channelId: string, page: PageRequest, at = new Date()) {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId }, select: { id: true, deletedAt: true, costTimezone: true }
    })
    if (!channel || (channel.deletedAt && page.lifecycle !== CatalogLifecycle.ARCHIVED && page.lifecycle !== CatalogLifecycle.ALL)) {
      throw new NotFoundException('Channel not found')
    }
    const where = { channelId, ...lifecycleWhere(page.lifecycle) }
    const [items, total] = await Promise.all([
      this.prisma.channelModel.findMany({
        where, include: { costRules: {
          where: lifecycleWhere(page.lifecycle), orderBy: [{ enabled: 'desc' }, { priority: 'desc' }, { validFrom: 'desc' }]
        } },
        orderBy: [{ publicModelId: 'asc' }, { upstreamModel: 'asc' }], skip: page.offset, take: page.limit
      }),
      this.prisma.channelModel.count({ where })
    ])
    const publicModels = items.length ? await this.prisma.publicModel.findMany({
      where: { id: { in: [...new Set(items.map(item => item.publicModelId))] }, deletedAt: null },
      include: { prices: {
        where: { deletedAt: null, enabled: true, validFrom: { lte: at }, OR: [{ validUntil: null }, { validUntil: { gt: at } }] },
        orderBy: { validFrom: 'desc' }, take: 1
      } }
    }) : []
    const fallbackByModel = new Map(publicModels.map(model => [model.id, model.prices[0]]))
    const alignedItems = items.map(item => {
      let currentCost = null
      if (!item.deletedAt) {
        try { currentCost = resolveChannelCost(item.costRules.map(toScheduledCost), at, channel.costTimezone) } catch {
          // An invalid legacy rule is unavailable; the catalog still exposes the model's valid fallback below.
        }
        const fallback = fallbackByModel.get(item.publicModelId)
        if (!currentCost && fallback) currentCost = {
          id: fallback.id, source: 'PUBLIC_MODEL_FALLBACK' as const,
          inputPerMillion: fallback.inputPerMillion.toString(), outputPerMillion: fallback.outputPerMillion.toString(),
          cachedPerMillion: fallback.cachedPerMillion.toString(), reasoningPerMillion: fallback.reasoningPerMillion.toString(),
          currency: 'CNY' as const, timezone: channel.costTimezone, resolvedAt: at.toISOString()
        }
      }
      return { ...item, currentCost }
    })
    return { items: alignedItems, total, limit: page.limit, offset: page.offset }
  }

  async archive(id: string) {
    const model = await this.prisma.channelModel.findUnique({ where: { id }, select: { id: true, deletedAt: true } })
    if (!model) throw new NotFoundException('Channel model not found')
    if (model.deletedAt) return { id, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt: model.deletedAt }
    const deletedAt = new Date()
    await this.prisma.$transaction(async transaction => {
      await transaction.channelModelCostRule.updateMany({
        where: { channelModelId: id, deletedAt: null }, data: { deletedAt, enabled: false }
      })
      await transaction.channelModel.update({
        where: { id }, data: { deletedAt, enabled: false, probeEnabled: false, health: 'DISABLED' }
      })
    })
    return { id, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt }
  }

  async restore(id: string) {
    const model = await this.prisma.channelModel.findUnique({
      where: { id }, select: { id: true, channelId: true, publicModelId: true, deletedAt: true }
    })
    if (!model) throw new NotFoundException('Channel model not found')
    if (!model.deletedAt) return { id, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
    const [channel, publicModel] = await Promise.all([
      this.prisma.channel.findUnique({ where: { id: model.channelId }, select: { id: true, deletedAt: true } }),
      this.prisma.publicModel.findUnique({ where: { id: model.publicModelId }, select: { id: true, deletedAt: true } })
    ])
    if (!channel || channel.deletedAt || !publicModel || publicModel.deletedAt) {
      throw new ConflictException('Parent catalog record must be restored first')
    }
    await this.prisma.channelModel.update({
      where: { id }, data: { deletedAt: null, enabled: false, probeEnabled: false, health: 'DISABLED' }
    })
    return { id, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
  }

  async create(channelId: string, input: CreateChannelModelInput) {
    const [channel, publicModel] = await Promise.all([
      this.prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, deletedAt: true } }),
      this.prisma.publicModel.findUnique({ where: { id: input.publicModelId }, select: { id: true, deletedAt: true } })
    ])
    if (!channel || channel.deletedAt) throw new NotFoundException('Channel not found')
    if (!publicModel || publicModel.deletedAt) throw new NotFoundException('Public model not found')
    const archivedMapping = await this.prisma.channelModel.findFirst({
      where: { channelId, publicModelId: input.publicModelId, protocol: input.protocol, deletedAt: { not: null } }, select: { id: true }
    })
    if (archivedMapping) throw new ConflictException('Channel model mapping is archived; restore it instead')
    return this.prisma.channelModel.create({ data: {
      channelId, publicModelId: input.publicModelId, upstreamModel: input.upstreamModel, protocol: input.protocol,
      supportsStream: input.supportsStream, supportsTools: input.supportsTools, probeEnabled: input.probeEnabled,
      probeIntervalMinutes: input.probeIntervalMinutes, health: 'UNKNOWN'
    } })
  }

  async update(id: string, input: UpdateChannelModelInput) {
    const model = await this.prisma.channelModel.findUnique({
      where: { id }, select: { id: true, channelId: true, publicModelId: true, deletedAt: true, health: true }
    })
    if (!model) throw new NotFoundException('Channel model not found')
    if (model.deletedAt) throw new ConflictException('Archived channel model cannot be edited')
    const [channel, publicModel] = await Promise.all([
      this.prisma.channel.findUnique({ where: { id: model.channelId }, select: { id: true, deletedAt: true } }),
      this.prisma.publicModel.findUnique({ where: { id: model.publicModelId }, select: { id: true, deletedAt: true } })
    ])
    if (!channel || channel.deletedAt || !publicModel || publicModel.deletedAt) {
      throw new ConflictException('Parent catalog record is archived')
    }
    const data = input.enabled === true && model.health === 'DISABLED' && input.health === undefined
      ? { ...input, health: 'UNKNOWN' as const }
      : input
    return this.prisma.channelModel.update({ where: { id }, data })
  }

  async listCostRules(channelModelId: string, lifecycle: CatalogLifecycle = CatalogLifecycle.ACTIVE) {
    const model = await this.prisma.channelModel.findUnique({ where: { id: channelModelId }, select: { id: true, deletedAt: true } })
    if (!model) throw new NotFoundException('Channel model not found')
    if (model.deletedAt && lifecycle === CatalogLifecycle.ACTIVE) throw new ConflictException('Channel model is archived')
    return this.prisma.channelModelCostRule.findMany({
      where: { channelModelId, ...lifecycleWhere(lifecycle) },
      orderBy: [{ priority: 'desc' }, { validFrom: 'desc' }, { createdAt: 'desc' }]
    })
  }

  async previewCostRule(channelModelId: string, input: PreviewChannelModelCostRuleInput, at = new Date()) {
    const model = await this.prisma.channelModel.findUnique({
      where: { id: channelModelId },
      include: { channel: { select: { costTimezone: true, deletedAt: true } }, costRules: true }
    })
    if (!model) throw new NotFoundException('Channel model not found')
    if (model.deletedAt) throw new ConflictException('Archived channel model cannot be previewed')
    const publicModel = await this.prisma.publicModel.findUnique({
      where: { id: model.publicModelId }, select: { id: true, deletedAt: true }
    })
    if (model.channel.deletedAt || !publicModel || publicModel.deletedAt) {
      throw new ConflictException('Parent catalog record is archived')
    }
    const candidate = costRuleFromInput(channelModelId, input, input.id || 'candidate')
    assertValidCostRule(candidate)
    const others = model.costRules.filter(rule => !rule.deletedAt && rule.enabled && rule.id !== input.id).map(toScheduledCost)
    const conflicts = others.filter(rule => rule.priority === candidate.priority && costRulesOverlap(rule, candidate))
    let resolved = null
    try { resolved = resolveChannelCost([...others, candidate], at, model.channel.costTimezone) } catch (error: any) {
      throw new BadRequestException(error?.message || 'Cost rule preview is invalid')
    }
    return {
      valid: conflicts.length === 0, candidateActiveNow: resolved?.id === candidate.id, resolved,
      conflicts: conflicts.map(rule => ({ id: rule.id, name: rule.name }))
    }
  }

  async listProbes(channelModelId: string, page: PageRequest) {
    const model = await this.prisma.channelModel.findUnique({ where: { id: channelModelId }, select: { id: true, deletedAt: true } })
    if (!model) throw new NotFoundException('Channel model not found')
    if (model.deletedAt) throw new ConflictException('Archived channel model cannot be inspected')
    const [items, total] = await Promise.all([
      this.prisma.channelModelProbe.findMany({ where: { channelModelId }, orderBy: { testedAt: 'desc' }, skip: page.offset, take: page.limit }),
      this.prisma.channelModelProbe.count({ where: { channelModelId } })
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  async createCostRule(channelModelId: string, input: CreateChannelModelCostRuleInput) {
    return this.prisma.$transaction(async transaction => {
      const model = await transaction.channelModel.findUnique({ where: { id: channelModelId }, select: { id: true, deletedAt: true } })
      if (!model) throw new NotFoundException('Channel model not found')
      if (model.deletedAt) throw new ConflictException('Archived channel model cannot be edited')
      await lockCostRules(transaction, channelModelId)
      const validFrom = new Date(input.validFrom)
      const validUntil = input.validUntil ? new Date(input.validUntil) : null
      if (!Number.isFinite(validFrom.getTime()) || (validUntil && (!Number.isFinite(validUntil.getTime()) || validUntil <= validFrom))) {
        throw new BadRequestException('Cost rule validity range is invalid')
      }
      const candidate = costRuleFromInput(channelModelId, input, 'candidate')
      assertValidCostRule(candidate)
      const existing = await transaction.channelModelCostRule.findMany({ where: { channelModelId, enabled: true, deletedAt: null } })
      const conflicts = existing.filter(rule => rule.priority === candidate.priority && costRulesOverlap(toScheduledCost(rule), candidate))
      if (conflicts.length) throw new ConflictException({
        message: 'Cost rule overlaps another rule at the same priority',
        conflicts: conflicts.map(rule => ({ id: rule.id, name: rule.name }))
      })
      return transaction.channelModelCostRule.create({ data: {
        channelModelId, name: input.name, daysOfWeek: input.daysOfWeek, startMinute: input.startMinute,
        endMinute: input.endMinute, priority: input.priority, inputPerMillion: input.inputPerMillion,
        outputPerMillion: input.outputPerMillion, cachedPerMillion: input.cachedPerMillion,
        reasoningPerMillion: input.reasoningPerMillion, currency: 'CNY', validFrom, validUntil
      } })
    }, { maxWait: 10_000, timeout: 15_000 })
  }

  async updateCostRule(id: string, input: UpdateChannelModelCostRuleInput) {
    return this.prisma.$transaction(async transaction => {
      const initial = await transaction.channelModelCostRule.findUnique({ where: { id } })
      if (!initial) throw new NotFoundException('Cost rule not found')
      if (initial.deletedAt) throw new ConflictException('Archived cost rule cannot be edited')
      const parent = await transaction.channelModel.findUnique({
        where: { id: initial.channelModelId }, select: { id: true, deletedAt: true }
      })
      if (!parent || parent.deletedAt) throw new ConflictException('Parent channel model is archived')
      await lockCostRules(transaction, initial.channelModelId)
      const existing = await transaction.channelModelCostRule.findUnique({ where: { id } })
      if (!existing) throw new NotFoundException('Cost rule not found')
      const definedInput = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined)
      ) as UpdateChannelModelCostRuleInput
      const merged = toScheduledCost({
        ...existing, ...definedInput,
        validFrom: definedInput.validFrom ? new Date(definedInput.validFrom) : existing.validFrom,
        validUntil: definedInput.validUntil !== undefined
          ? (definedInput.validUntil ? new Date(definedInput.validUntil) : null)
          : existing.validUntil
      })
      if (!Number.isFinite(merged.validFrom.getTime()) || (merged.validUntil &&
        (!Number.isFinite(merged.validUntil.getTime()) || merged.validUntil <= merged.validFrom))) {
        throw new BadRequestException('Cost rule validity range is invalid')
      }
      assertValidCostRule(merged)
      const others = await transaction.channelModelCostRule.findMany({
        where: { channelModelId: existing.channelModelId, enabled: true, deletedAt: null, id: { not: id } }
      })
      const conflicts = merged.enabled ? others.filter(rule => rule.priority === merged.priority && costRulesOverlap(toScheduledCost(rule), merged)) : []
      if (conflicts.length) throw new ConflictException({
        message: 'Cost rule overlaps another rule at the same priority',
        conflicts: conflicts.map(rule => ({ id: rule.id, name: rule.name }))
      })
      return transaction.channelModelCostRule.update({ where: { id }, data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.daysOfWeek !== undefined ? { daysOfWeek: input.daysOfWeek } : {}),
        ...(input.startMinute !== undefined ? { startMinute: input.startMinute } : {}),
        ...(input.endMinute !== undefined ? { endMinute: input.endMinute } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.inputPerMillion !== undefined ? { inputPerMillion: input.inputPerMillion } : {}),
        ...(input.outputPerMillion !== undefined ? { outputPerMillion: input.outputPerMillion } : {}),
        ...(input.cachedPerMillion !== undefined ? { cachedPerMillion: input.cachedPerMillion } : {}),
        ...(input.reasoningPerMillion !== undefined ? { reasoningPerMillion: input.reasoningPerMillion } : {}),
        ...(input.validFrom !== undefined ? { validFrom: merged.validFrom } : {}),
        ...(input.validUntil !== undefined ? { validUntil: merged.validUntil } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {})
      } })
    }, { maxWait: 10_000, timeout: 15_000 })
  }

  async archiveCostRule(id: string) {
    const rule = await this.prisma.channelModelCostRule.findUnique({ where: { id } })
    if (!rule) throw new NotFoundException('Cost rule not found')
    if (rule.deletedAt) return { id, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt: rule.deletedAt }
    const deletedAt = new Date()
    await this.prisma.channelModelCostRule.update({ where: { id }, data: { deletedAt, enabled: false } })
    return { id, lifecycle: CatalogLifecycle.ARCHIVED, deletedAt }
  }

  async restoreCostRule(id: string) {
    const rule = await this.prisma.channelModelCostRule.findUnique({ where: { id } })
    if (!rule) throw new NotFoundException('Cost rule not found')
    const parent = await this.prisma.channelModel.findUnique({
      where: { id: rule.channelModelId }, select: { id: true, deletedAt: true }
    })
    if (!parent || parent.deletedAt) throw new ConflictException('Parent channel model is archived')
    if (!rule.deletedAt) return { id, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
    if (rule.currency !== 'CNY') {
      throw new ConflictException('Legacy-currency cost rules cannot be restored; create a new CNY rule instead')
    }
    await this.prisma.channelModelCostRule.update({ where: { id }, data: { deletedAt: null, enabled: false } })
    return { id, lifecycle: CatalogLifecycle.ACTIVE, deletedAt: null }
  }

  async publishCheck(publicModelId: string, at = new Date()) {
    const publicModel = await this.prisma.publicModel.findUnique({
      where: { id: publicModelId },
      include: { prices: { where: { deletedAt: null, enabled: true, validFrom: { lte: at }, OR: [{ validUntil: null }, { validUntil: { gt: at } }] },
        orderBy: { validFrom: 'desc' }, take: 1 } }
    })
    if (!publicModel || publicModel.deletedAt) throw new NotFoundException('Public model not found')
    const channelModels = await this.prisma.channelModel.findMany({
      where: { publicModelId, deletedAt: null, channel: { deletedAt: null } },
      include: {
        channel: { include: { keys: { where: { deletedAt: null } } } },
        costRules: { where: { enabled: true, deletedAt: null } }
      }
    })
    const routingCandidates = channelModels.filter(model => {
      const channel = model.channel
      if (model.deletedAt || channel.deletedAt || !model.enabled || !channel.enabled || !['HEALTHY', 'DEGRADED'].includes(model.health) ||
        !['HEALTHY', 'DEGRADED'].includes(channel.health) || (channel.circuitOpenUntil && channel.circuitOpenUntil >= at)) return false
      return Boolean(selectKey(channel.keys.filter(key => !key.deletedAt).map(key => ({
        ...key, remainingUsd: key.remainingUsd === null ? null : Number(key.remainingUsd),
        healthy: key.health === 'HEALTHY' || key.health === 'DEGRADED'
      })), () => 0, at))
    })
    const healthyChannelModels = routingCandidates.length
    const readyCandidates = routingCandidates.filter(model => {
      try {
        return Boolean(resolveChannelCost(model.costRules.filter(rule => !rule.deletedAt).map(toScheduledCost), at, model.channel.costTimezone) || publicModel.prices[0])
      } catch { return false }
    })
    const hasCurrentCost = readyCandidates.length > 0
    const blockers: Array<'NO_HEALTHY_CHANNEL_MODEL' | 'NO_CURRENT_COST' | 'LATEST_TEST_FAILED'> = []
    if (!healthyChannelModels) blockers.push('NO_HEALTHY_CHANNEL_MODEL')
    if (!hasCurrentCost) blockers.push('NO_CURRENT_COST')
    if (readyCandidates.some(model => model.lastTestedAt) && !readyCandidates.some(model => model.health === 'HEALTHY')) {
      blockers.push('LATEST_TEST_FAILED')
    }
    return { ready: blockers.length === 0, healthyChannelModels, hasCurrentCost, blockers }
  }
}

function lifecycleWhere(lifecycle: CatalogLifecycle = CatalogLifecycle.ACTIVE): Record<string, unknown> {
  if (lifecycle === CatalogLifecycle.ALL) return {}
  return lifecycle === CatalogLifecycle.ARCHIVED ? { deletedAt: { not: null } } : { deletedAt: null }
}

function assertValidCostRule(rule: ScheduledCost): void {
  try { validateScheduledCost(rule) } catch (error: any) {
    throw new BadRequestException(error?.message || 'Cost rule is invalid')
  }
}

function costRuleFromInput(channelModelId: string, input: CreateChannelModelCostRuleInput, id: string): ScheduledCost {
  const validFrom = new Date(input.validFrom)
  const validUntil = input.validUntil ? new Date(input.validUntil) : null
  if (!Number.isFinite(validFrom.getTime()) || (validUntil && (!Number.isFinite(validUntil.getTime()) || validUntil <= validFrom))) {
    throw new BadRequestException('Cost rule validity range is invalid')
  }
  return {
    id, name: input.name, daysOfWeek: input.daysOfWeek, startMinute: input.startMinute, endMinute: input.endMinute,
    priority: input.priority, inputPerMillion: input.inputPerMillion, outputPerMillion: input.outputPerMillion,
    cachedPerMillion: input.cachedPerMillion, reasoningPerMillion: input.reasoningPerMillion,
    currency: 'CNY', enabled: true, validFrom, validUntil, createdAt: new Date()
  }
}

async function lockCostRules(transaction: any, channelModelId: string): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${channelModelId}, 0))`)
}

function toScheduledCost(rule: any): ScheduledCost {
  return {
    ...rule,
    inputPerMillion: rule.inputPerMillion.toString(), outputPerMillion: rule.outputPerMillion.toString(),
    cachedPerMillion: rule.cachedPerMillion.toString(), reasoningPerMillion: rule.reasoningPerMillion.toString()
  }
}
