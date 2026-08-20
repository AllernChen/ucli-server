import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { costRulesOverlap, type ScheduledCost } from '../../../packages/gateway-core/src/cost-schedule.js'

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
        where: { channelId }, include: { costRules: { where: { enabled: true }, orderBy: [{ priority: 'desc' }, { validFrom: 'desc' }] } },
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
      const candidate: ScheduledCost = {
        id: 'candidate', channelModelId, name: input.name, daysOfWeek: input.daysOfWeek,
        startMinute: input.startMinute, endMinute: input.endMinute, priority: input.priority,
        inputPerMillion: input.inputPerMillion, outputPerMillion: input.outputPerMillion,
        cachedPerMillion: input.cachedPerMillion, reasoningPerMillion: input.reasoningPerMillion,
        currency: 'USD', enabled: true, validFrom, validUntil, createdAt: new Date()
      } as ScheduledCost
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
      const others = await transaction.channelModelCostRule.findMany({
        where: { channelModelId: existing.channelModelId, enabled: true, id: { not: id } }
      })
      const conflicts = others.filter(rule => rule.priority === merged.priority && costRulesOverlap(toScheduledCost(rule), merged))
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
      include: { prices: { where: { validFrom: { lte: at }, OR: [{ validUntil: null }, { validUntil: { gt: at } }] }, take: 1 } }
    })
    if (!publicModel) throw new NotFoundException('Public model not found')
    const channelModels = await this.prisma.channelModel.findMany({
      where: { publicModelId },
      include: {
        channel: { select: { enabled: true } },
        costRules: { where: { enabled: true, validFrom: { lte: at }, OR: [{ validUntil: null }, { validUntil: { gt: at } }] } }
      }
    })
    const healthyChannelModels = channelModels.filter(model => model.enabled && model.channel.enabled &&
      (model.health === 'HEALTHY' || model.health === 'DEGRADED')).length
    const hasCurrentCost = publicModel.prices.length > 0 || channelModels.some(model => model.costRules.length > 0)
    const blockers: Array<'NO_HEALTHY_CHANNEL_MODEL' | 'NO_CURRENT_COST' | 'LATEST_TEST_FAILED'> = []
    if (!healthyChannelModels) blockers.push('NO_HEALTHY_CHANNEL_MODEL')
    if (!hasCurrentCost) blockers.push('NO_CURRENT_COST')
    if (channelModels.some(model => model.lastTestedAt) && !channelModels.some(model => model.enabled && model.health === 'HEALTHY')) {
      blockers.push('LATEST_TEST_FAILED')
    }
    return { ready: blockers.length === 0, healthyChannelModels, hasCurrentCost, blockers }
  }
}

function toScheduledCost(rule: any): ScheduledCost {
  return {
    ...rule,
    inputPerMillion: rule.inputPerMillion.toString(), outputPerMillion: rule.outputPerMillion.toString(),
    cachedPerMillion: rule.cachedPerMillion.toString(), reasoningPerMillion: rule.reasoningPerMillion.toString()
  }
}
