import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import {
  costRulesOverlap, resolveChannelCost, validateScheduledCost, type ScheduledCost
} from '../../../packages/gateway-core/src/cost-schedule.js'
import { selectKey } from '../../../packages/gateway-core/src/routing.js'

export interface PageRequest { limit: number; offset: number }

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
  validUntil?: string
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

  async listByChannel(channelId: string, page: PageRequest) {
    if (!await this.prisma.channel.findUnique({ where: { id: channelId }, select: { id: true } })) {
      throw new NotFoundException('Channel not found')
    }
    const [items, total] = await Promise.all([
      this.prisma.channelModel.findMany({
        where: { channelId }, include: { costRules: { orderBy: [{ enabled: 'desc' }, { priority: 'desc' }, { validFrom: 'desc' }] } },
        orderBy: [{ publicModelId: 'asc' }, { upstreamModel: 'asc' }], skip: page.offset, take: page.limit
      }),
      this.prisma.channelModel.count({ where: { channelId } })
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  async remove(id: string) {
    if (!await this.prisma.channelModel.findUnique({ where: { id } })) throw new NotFoundException('Channel model not found')
    const usageCount = await this.prisma.usageLog.count({ where: { channelModelId: id } })
    return usageCount > 0
      ? this.prisma.channelModel.update({ where: { id }, data: { enabled: false, health: 'DISABLED' } })
      : this.prisma.channelModel.delete({ where: { id } })
  }

  async create(channelId: string, input: CreateChannelModelInput) {
    const [channel, publicModel] = await Promise.all([
      this.prisma.channel.findUnique({ where: { id: channelId }, select: { id: true } }),
      this.prisma.publicModel.findUnique({ where: { id: input.publicModelId }, select: { id: true } })
    ])
    if (!channel) throw new NotFoundException('Channel not found')
    if (!publicModel) throw new NotFoundException('Public model not found')
    return this.prisma.channelModel.create({ data: {
      channelId, publicModelId: input.publicModelId, upstreamModel: input.upstreamModel, protocol: input.protocol,
      supportsStream: input.supportsStream, supportsTools: input.supportsTools, probeEnabled: input.probeEnabled,
      probeIntervalMinutes: input.probeIntervalMinutes, health: 'UNKNOWN'
    } })
  }

  async update(id: string, input: UpdateChannelModelInput) {
    if (!await this.prisma.channelModel.findUnique({ where: { id }, select: { id: true } })) {
      throw new NotFoundException('Channel model not found')
    }
    return this.prisma.channelModel.update({ where: { id }, data: input })
  }

  async listCostRules(channelModelId: string) {
    if (!await this.prisma.channelModel.findUnique({ where: { id: channelModelId }, select: { id: true } })) {
      throw new NotFoundException('Channel model not found')
    }
    return this.prisma.channelModelCostRule.findMany({
      where: { channelModelId }, orderBy: [{ priority: 'desc' }, { validFrom: 'desc' }, { createdAt: 'desc' }]
    })
  }

  async previewCostRule(channelModelId: string, input: PreviewChannelModelCostRuleInput, at = new Date()) {
    const model = await this.prisma.channelModel.findUnique({
      where: { id: channelModelId }, include: { channel: { select: { costTimezone: true } }, costRules: true }
    })
    if (!model) throw new NotFoundException('Channel model not found')
    const candidate = costRuleFromInput(channelModelId, input, input.id || 'candidate')
    assertValidCostRule(candidate)
    const others = model.costRules.filter(rule => rule.enabled && rule.id !== input.id).map(toScheduledCost)
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
    if (!await this.prisma.channelModel.findUnique({ where: { id: channelModelId }, select: { id: true } })) {
      throw new NotFoundException('Channel model not found')
    }
    const [items, total] = await Promise.all([
      this.prisma.channelModelProbe.findMany({ where: { channelModelId }, orderBy: { testedAt: 'desc' }, skip: page.offset, take: page.limit }),
      this.prisma.channelModelProbe.count({ where: { channelModelId } })
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  async createCostRule(channelModelId: string, input: CreateChannelModelCostRuleInput) {
    return this.prisma.$transaction(async transaction => {
      if (!await transaction.channelModel.findUnique({ where: { id: channelModelId }, select: { id: true } })) {
        throw new NotFoundException('Channel model not found')
      }
      const validFrom = new Date(input.validFrom)
      const validUntil = input.validUntil ? new Date(input.validUntil) : null
      if (!Number.isFinite(validFrom.getTime()) || (validUntil && (!Number.isFinite(validUntil.getTime()) || validUntil <= validFrom))) {
        throw new BadRequestException('Cost rule validity range is invalid')
      }
      const candidate = costRuleFromInput(channelModelId, input, 'candidate')
      assertValidCostRule(candidate)
      const existing = await transaction.channelModelCostRule.findMany({ where: { channelModelId, enabled: true } })
      const conflicts = existing.filter(rule => rule.priority === candidate.priority && costRulesOverlap(toScheduledCost(rule), candidate))
      if (conflicts.length) throw new ConflictException({
        message: 'Cost rule overlaps another rule at the same priority',
        conflicts: conflicts.map(rule => ({ id: rule.id, name: rule.name }))
      })
      return transaction.channelModelCostRule.create({ data: {
        channelModelId, name: input.name, daysOfWeek: input.daysOfWeek, startMinute: input.startMinute,
        endMinute: input.endMinute, priority: input.priority, inputPerMillion: input.inputPerMillion,
        outputPerMillion: input.outputPerMillion, cachedPerMillion: input.cachedPerMillion,
        reasoningPerMillion: input.reasoningPerMillion, currency: 'USD', validFrom, validUntil
      } })
    })
  }

  async updateCostRule(id: string, input: UpdateChannelModelCostRuleInput) {
    return this.prisma.$transaction(async transaction => {
      const existing = await transaction.channelModelCostRule.findUnique({ where: { id } })
      if (!existing) throw new NotFoundException('Cost rule not found')
      const merged = toScheduledCost({
        ...existing, ...input,
        validFrom: input.validFrom ? new Date(input.validFrom) : existing.validFrom,
        validUntil: input.validUntil !== undefined ? (input.validUntil ? new Date(input.validUntil) : null) : existing.validUntil
      })
      if (!Number.isFinite(merged.validFrom.getTime()) || (merged.validUntil &&
        (!Number.isFinite(merged.validUntil.getTime()) || merged.validUntil <= merged.validFrom))) {
        throw new BadRequestException('Cost rule validity range is invalid')
      }
      assertValidCostRule(merged)
      const others = await transaction.channelModelCostRule.findMany({
        where: { channelModelId: existing.channelModelId, enabled: true, id: { not: id } }
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
    })
  }

  async removeCostRule(id: string) {
    if (!await this.prisma.channelModelCostRule.findUnique({ where: { id } })) throw new NotFoundException('Cost rule not found')
    const usageCount = await this.prisma.usageLog.count({ where: { channelCostRuleId: id } })
    return usageCount > 0
      ? this.prisma.channelModelCostRule.update({ where: { id }, data: { enabled: false } })
      : this.prisma.channelModelCostRule.delete({ where: { id } })
  }

  async publishCheck(publicModelId: string, at = new Date()) {
    const publicModel = await this.prisma.publicModel.findUnique({
      where: { id: publicModelId },
      include: { prices: { where: { validFrom: { lte: at }, OR: [{ validUntil: null }, { validUntil: { gt: at } }] },
        orderBy: { validFrom: 'desc' }, take: 1 } }
    })
    if (!publicModel) throw new NotFoundException('Public model not found')
    const channelModels = await this.prisma.channelModel.findMany({
      where: { publicModelId },
      include: {
        channel: { include: { keys: true } },
        costRules: { where: { enabled: true } }
      }
    })
    const routingCandidates = channelModels.filter(model => {
      const channel = model.channel
      if (!model.enabled || !channel.enabled || !['HEALTHY', 'DEGRADED'].includes(model.health) ||
        !['HEALTHY', 'DEGRADED'].includes(channel.health) || (channel.circuitOpenUntil && channel.circuitOpenUntil >= at)) return false
      return Boolean(selectKey(channel.keys.map(key => ({
        ...key, remainingUsd: key.remainingUsd === null ? null : Number(key.remainingUsd),
        healthy: key.health === 'HEALTHY' || key.health === 'DEGRADED'
      })), () => 0, at))
    })
    const healthyChannelModels = routingCandidates.length
    const readyCandidates = routingCandidates.filter(model => {
      try {
        return Boolean(resolveChannelCost(model.costRules.map(toScheduledCost), at, model.channel.costTimezone) || publicModel.prices[0])
      } catch { return false }
    })
    const hasCurrentCost = readyCandidates.length > 0
    const blockers: Array<'NO_HEALTHY_CHANNEL_MODEL' | 'NO_CURRENT_COST' | 'LATEST_TEST_FAILED'> = []
    if (!healthyChannelModels) blockers.push('NO_HEALTHY_CHANNEL_MODEL')
    if (!hasCurrentCost) blockers.push('NO_CURRENT_COST')
    if (channelModels.some(model => model.lastTestedAt) && !channelModels.some(model => model.enabled && model.health === 'HEALTHY')) {
      blockers.push('LATEST_TEST_FAILED')
    }
    return { ready: blockers.length === 0, healthyChannelModels, hasCurrentCost, blockers }
  }
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
    currency: 'USD', enabled: true, validFrom, validUntil, createdAt: new Date()
  }
}

function toScheduledCost(rule: any): ScheduledCost {
  return {
    ...rule,
    inputPerMillion: rule.inputPerMillion.toString(), outputPerMillion: rule.outputPerMillion.toString(),
    cachedPerMillion: rule.cachedPerMillion.toString(), reasoningPerMillion: rule.reasoningPerMillion.toString()
  }
}
