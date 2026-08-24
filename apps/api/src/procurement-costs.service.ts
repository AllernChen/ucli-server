import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { estimateProcurementCost } from '../../../packages/gateway-core/src/cost.js'
import {
  nextCostTransition, resolveChannelCostWithFallback, type PublicModelFallbackCost, type ScheduledCost
} from '../../../packages/gateway-core/src/cost-schedule.js'
import {
  CostEvaluationDto, ProcurementCostQueryDto, ProcurementCostStatus
} from './catalog.dto.js'

const WEEK_MINUTES = 7 * 24 * 60

function amount(value: unknown): string { return String(value) }

function scheduledCost(rule: any): ScheduledCost {
  return {
    ...rule, inputPerMillion: amount(rule.inputPerMillion), outputPerMillion: amount(rule.outputPerMillion),
    cachedPerMillion: amount(rule.cachedPerMillion), reasoningPerMillion: amount(rule.reasoningPerMillion)
  }
}

function fallbackCost(price: any | undefined): PublicModelFallbackCost | null {
  if (!price) return null
  return {
    id: price.id, currency: price.currency, inputPerMillion: amount(price.inputPerMillion),
    outputPerMillion: amount(price.outputPerMillion), cachedPerMillion: amount(price.cachedPerMillion),
    reasoningPerMillion: amount(price.reasoningPerMillion)
  }
}

function activeFallback(prices: any[], at: Date): PublicModelFallbackCost | null {
  const price = prices.find(item => !item.deletedAt && item.enabled && item.validFrom <= at && (!item.validUntil || item.validUntil > at))
  return fallbackCost(price)
}

function activeRules(rules: ScheduledCost[], at: Date): ScheduledCost[] {
  return rules.filter(rule => rule.enabled && rule.validFrom <= at && (!rule.validUntil || rule.validUntil > at))
}

function weeklyCoverage(rules: ScheduledCost[], hasFallback: boolean) {
  const covered = Array<boolean>(WEEK_MINUTES).fill(false)
  const mark = (day: number, start: number, end: number) => {
    const offset = (day - 1) * 1440
    for (let minute = start; minute < end; minute++) covered[offset + minute] = true
  }
  for (const rule of rules) {
    for (const day of rule.daysOfWeek) {
      if (rule.startMinute === rule.endMinute) mark(day, 0, 1440)
      else if (rule.startMinute < rule.endMinute) mark(day, rule.startMinute, rule.endMinute)
      else {
        mark(day, rule.startMinute, 1440)
        mark(day === 7 ? 1 : day + 1, 0, rule.endMinute)
      }
    }
  }
  const channelRuleMinutes = covered.filter(Boolean).length
  const remaining = WEEK_MINUTES - channelRuleMinutes
  return {
    channelRuleMinutes,
    fallbackMinutes: hasFallback ? remaining : 0,
    uncoveredMinutes: hasFallback ? 0 : remaining
  }
}

function statusFor(model: any, coverage: ReturnType<typeof weeklyCoverage>, fallback: PublicModelFallbackCost | null, futureRules: number) {
  if (!model.enabled || !model.channel.enabled || model.health === 'DISABLED') return ProcurementCostStatus.DISABLED
  if (coverage.channelRuleMinutes === WEEK_MINUTES) return ProcurementCostStatus.CHANNEL_RULE_ACTIVE
  if (coverage.channelRuleMinutes > 0 && fallback) return ProcurementCostStatus.PARTIAL_FALLBACK
  if (coverage.channelRuleMinutes === 0 && futureRules > 0) return ProcurementCostStatus.UPCOMING
  if (coverage.channelRuleMinutes === 0 && fallback) return ProcurementCostStatus.FALLBACK_ONLY
  return ProcurementCostStatus.NO_COST
}

function serializeRule(rule: ScheduledCost) {
  return {
    ...rule, inputPerMillion: amount(rule.inputPerMillion), outputPerMillion: amount(rule.outputPerMillion),
    cachedPerMillion: amount(rule.cachedPerMillion), reasoningPerMillion: amount(rule.reasoningPerMillion)
  }
}

@Injectable()
export class ProcurementCostsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ProcurementCostQueryDto, at = new Date()) {
    const where: any = {
      deletedAt: null, channel: { deletedAt: null }, publicModel: { deletedAt: null }
    }
    if (query.channelId) where.channelId = query.channelId
    if (query.publicModelId) where.publicModelId = query.publicModelId
    if (query.manufacturer) where.publicModel.manufacturerKey = query.manufacturer
    if (query.search) where.OR = [
      { upstreamModel: { contains: query.search, mode: 'insensitive' } },
      { channel: { name: { contains: query.search, mode: 'insensitive' } } },
      { publicModel: { displayName: { contains: query.search, mode: 'insensitive' } } },
      { publicModelId: { contains: query.search, mode: 'insensitive' } }
    ]
    const models = await this.prisma.channelModel.findMany({
      where,
      include: {
        channel: { select: { id: true, name: true, enabled: true, deletedAt: true, costTimezone: true } },
        publicModel: { include: { prices: {
          where: { deletedAt: null, enabled: true, validFrom: { lte: at }, OR: [{ validUntil: null }, { validUntil: { gt: at } }] },
          orderBy: { validFrom: 'desc' }, take: 1
        } } },
        costRules: { where: { deletedAt: null }, orderBy: [{ enabled: 'desc' }, { priority: 'desc' }, { validFrom: 'desc' }] }
      },
      orderBy: [{ publicModel: { manufacturerKey: 'asc' } }, { publicModelId: 'asc' }, { channel: { name: 'asc' } }]
    })
    const allItems = models.map((model: any) => this.workspaceItem(model, at))
    const filtered = query.status ? allItems.filter(item => item.status === query.status) : allItems
    return {
      items: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length,
      limit: query.limit, offset: query.offset
    }
  }

  async evaluate(channelModelId: string, input: CostEvaluationDto) {
    const at = new Date(input.at)
    const model: any = await this.prisma.channelModel.findUnique({
      where: { id: channelModelId },
      include: {
        channel: { select: { id: true, enabled: true, deletedAt: true, costTimezone: true } },
        publicModel: { include: { prices: {
          where: { deletedAt: null, enabled: true, validFrom: { lte: at }, OR: [{ validUntil: null }, { validUntil: { gt: at } }] },
          orderBy: { validFrom: 'desc' }, take: 1
        } } },
        costRules: { where: { deletedAt: null } }
      }
    })
    if (!model) throw new NotFoundException('Channel model not found')
    if (model.deletedAt || model.channel.deletedAt || model.publicModel.deletedAt) {
      throw new ConflictException('Archived catalog records cannot be evaluated')
    }
    const rules: ScheduledCost[] = model.costRules.map(scheduledCost)
    const fallback = activeFallback(model.publicModel.prices, at)
    const cost = resolveChannelCostWithFallback(rules, fallback, at, model.channel.costTimezone)
    return {
      channelModelId, timezone: model.channel.costTimezone, at: at.toISOString(), cost,
      estimate: cost ? estimateProcurementCost(cost, input) : null,
      nextTransition: nextCostTransition(rules, fallback, at, model.channel.costTimezone)
    }
  }

  private workspaceItem(model: any, at: Date) {
    const rules: ScheduledCost[] = model.costRules.map(scheduledCost)
    const active = activeRules(rules, at)
    const fallback = activeFallback(model.publicModel.prices, at)
    const futureRules = rules.filter(rule => rule.enabled && rule.validFrom > at).length
    const coverage = weeklyCoverage(active, Boolean(fallback))
    const disabled = !model.enabled || !model.channel.enabled || model.health === 'DISABLED'
    const currentCost = disabled ? null : resolveChannelCostWithFallback(rules, fallback, at, model.channel.costTimezone)
    return {
      channelModelId: model.id, channelId: model.channelId, channelName: model.channel.name,
      publicModelId: model.publicModelId, publicModelName: model.publicModel.displayName,
      manufacturer: model.publicModel.manufacturer, manufacturerKey: model.publicModel.manufacturerKey,
      upstreamModel: model.upstreamModel, protocol: model.protocol, health: model.health, enabled: model.enabled,
      timezone: model.channel.costTimezone, status: statusFor(model, coverage, fallback, futureRules),
      currentCost, fallback, coverage,
      ruleCounts: { active: active.length, future: futureRules, disabled: rules.filter(rule => !rule.enabled).length },
      nextTransition: disabled ? null : nextCostTransition(rules, fallback, at, model.channel.costTimezone),
      rules: rules.map(serializeRule)
    }
  }
}
