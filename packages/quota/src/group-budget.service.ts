import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { Prisma, type GroupBudgetEntry, type GroupBudgetPeriod, type UsageGroup } from '@prisma/client'
import { createHash } from 'node:crypto'
import Decimal from 'decimal.js'
import { PrismaService } from '../../database/src/prisma.service.js'
import { assertActiveGroupMember, lockUsageGroup } from '../../security/src/group-access.js'
import type { GatewayIdentity } from '../../security/src/gateway-auth.js'
import type { AuthPrincipal } from '../../security/src/auth.js'
import { availableCny, budgetPeriodKey, cny } from './group-budget.js'
import type { RedisQuotaService } from './redis-quota.js'

export type BudgetReservation = { id: string; requestId: string; periodId: string; groupId: string; reservedCny: string }
type Db = Prisma.TransactionClient
const object = (value: Prisma.JsonValue) => value as Prisma.JsonObject
// Stable fingerprints compare retries without storing request bodies or secrets in the ledger.
function fingerprint(value: unknown): string {
  const canonical = (v: any): any => v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() :
    Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value ?? null))).digest('hex')
}
const conflict = () => new ConflictException('Budget operation conflicts with the recorded state')
const reference = (entry: GroupBudgetEntry): BudgetReservation => ({ id: entry.id, requestId: entry.requestId!, periodId: entry.periodId,
  groupId: entry.groupId, reservedCny: entry.reservedCny.toFixed(8) })

@Injectable()
export class GroupBudgetService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(actor: AuthPrincipal) {
    if (!['PLATFORM_ADMIN', 'ORG_ADMIN'].includes(actor.role)) throw new ForbiddenException('Administrator required')
  }

  async summary(actor: AuthPrincipal, groupId: string) {
    this.assertAdmin(actor)
    const group = await this.prisma.usageGroup.findFirst({ where: { id: groupId, organizationId: actor.organizationId } })
    if (!group) throw new NotFoundException('Usage group not found')
    const periodKey = budgetPeriodKey(group.budgetMode, group.budgetTimezone, new Date())
    const period = await this.prisma.groupBudgetPeriod.findUnique({ where: { groupId_periodKey: { groupId, periodKey } } })
    const uncertain = period ? await this.prisma.groupBudgetEntry.aggregate({ where: { periodId: period.id, kind: 'REQUEST', status: 'RECONCILIATION_REQUIRED' }, _sum: { reservedCny: true } }) : null
    const limitCny = (period?.limitCny ?? group.defaultLimitCny).toFixed(8)
    const spentCny = period?.spentCny.toFixed(8) ?? '0.00000000'; const reservedCny = period?.reservedCny.toFixed(8) ?? '0.00000000'
    return { groupId, periodId: period?.id ?? null, periodKey, budgetMode: group.budgetMode, budgetTimezone: group.budgetTimezone,
      unlimited: period?.unlimited ?? group.unlimited, defaultUnlimited: group.unlimited, defaultLimitCny: group.defaultLimitCny.toFixed(8),
      limitCny, spentCny, reservedCny, uncertainCny: uncertain?._sum.reservedCny?.toFixed(8) ?? '0.00000000',
      availableCny: (period?.unlimited ?? group.unlimited) ? null : availableCny(limitCny, spentCny, reservedCny) }
  }

  async entries(actor: AuthPrincipal, groupId: string, query: { offset: number; limit: number }) {
    await this.summary(actor, groupId)
    const where = { organizationId: actor.organizationId, groupId }
    const [items, total] = await Promise.all([
      this.prisma.groupBudgetEntry.findMany({ where, skip: query.offset, take: query.limit, orderBy: [{ startedAt: 'desc' }, { id: 'asc' }] }),
      this.prisma.groupBudgetEntry.count({ where })
    ])
    return { items, total, ...query }
  }

  private async operation(db: Db, actor: AuthPrincipal, groupId: string, input: { operationId: string; reason: string }, payload: unknown) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId) || !input.reason?.trim() || input.reason.length > 2000) throw new BadRequestException('Operation UUID and reason (1–2000 characters) are required')
    const hash = fingerprint({ groupId, actor: actor.sub, payload })
    const existing = await db.groupBudgetEntry.findUnique({ where: { operationId: input.operationId } })
    if (existing && (existing.organizationId !== actor.organizationId || object(existing.snapshot).operationFingerprint !== hash)) throw conflict()
    return { existing, hash }
  }

  private async adjustment(db: Db, actor: AuthPrincipal, period: GroupBudgetPeriod, input: { operationId: string; reason: string }, kind: 'LIMIT_ADJUSTMENT' | 'COST_ADJUSTMENT', snapshot: Prisma.InputJsonObject) {
    const entry = await db.groupBudgetEntry.create({ data: { organizationId: actor.organizationId, groupId: period.groupId, periodId: period.id,
      operationId: input.operationId, kind, status: 'SETTLED', reason: input.reason, actorAccountId: actor.sub, snapshot } })
    await db.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub, action: `GROUP_BUDGET_${kind}`,
      resourceType: 'group_budget_entry', resourceId: entry.id, metadata: snapshot } })
    return entry
  }

  async adjust(actor: AuthPrincipal, groupId: string, input: { operationId: string; scope: 'CURRENT' | 'DEFAULT'; periodId?: string; limitCny: string; unlimited: boolean; reason: string }) {
    this.assertAdmin(actor); const amount = cny(input.limitCny)
    if (!['CURRENT', 'DEFAULT'].includes(input.scope) || typeof input.unlimited !== 'boolean' || (input.scope === 'DEFAULT' && input.periodId)) throw new BadRequestException('Invalid adjustment scope')
    return this.prisma.$transaction(async db => {
      const group = await lockUsageGroup(db, actor.organizationId, groupId)
      const operation = await this.operation(db, actor, groupId, input, { ...input, limitCny: amount })
      if (operation.existing) return operation.existing
      if (group.archivedAt) throw conflict()
      const period = input.periodId ? await db.groupBudgetPeriod.findFirst({ where: { id: input.periodId, groupId, organizationId: actor.organizationId } }) : await this.period(db, group, new Date())
      if (!period) throw new NotFoundException('Budget period not found')
      await db.$queryRaw`SELECT id FROM group_budget_periods WHERE id = ${period.id}::uuid FOR UPDATE`
      const before = input.scope === 'CURRENT' ? { limitCny: period.limitCny.toFixed(8), unlimited: period.unlimited } : { limitCny: group.defaultLimitCny.toFixed(8), unlimited: group.unlimited }
      if (input.scope === 'CURRENT') {
        if (!input.unlimited && new Decimal(amount).lt(new Decimal(period.spentCny.toString()).plus(period.reservedCny.toString()))) throw conflict()
        await db.groupBudgetPeriod.update({ where: { id: period.id }, data: { limitCny: amount, unlimited: input.unlimited } })
        await this.alert(db, period.id)
      } else {
        await db.usageGroup.update({ where: { id: groupId }, data: { defaultLimitCny: amount, unlimited: input.unlimited } })
      }
      return this.adjustment(db, actor, period, input, 'LIMIT_ADJUSTMENT', { operationFingerprint: operation.hash, scope: input.scope,
        before, after: { limitCny: amount, unlimited: input.unlimited } })
    })
  }

  async configure(actor: AuthPrincipal, groupId: string, input: { operationId: string; budgetMode: 'TOTAL' | 'MONTHLY'; budgetTimezone: string; reason: string }) {
    this.assertAdmin(actor)
    if (!['TOTAL', 'MONTHLY'].includes(input.budgetMode)) throw new BadRequestException('Invalid budget mode')
    budgetPeriodKey(input.budgetMode, input.budgetTimezone, new Date())
    return this.prisma.$transaction(async db => {
      const group = await lockUsageGroup(db, actor.organizationId, groupId)
      const operation = await this.operation(db, actor, groupId, input, input)
      if (operation.existing) return operation.existing
      if (group.archivedAt) throw conflict()
      const period = await this.period(db, group, new Date())
      if (input.budgetMode !== group.budgetMode || input.budgetTimezone !== group.budgetTimezone) {
        const targetKey = budgetPeriodKey(input.budgetMode, input.budgetTimezone, new Date())
        const occupied = await db.groupBudgetEntry.count({ where: { groupId, kind: 'REQUEST', OR: [
          { periodId: period.id }, { status: { in: ['RESERVED', 'RECONCILIATION_REQUIRED'] } }, { period: { periodKey: targetKey } }
        ] } })
        if (occupied) throw conflict()
      }
      await db.usageGroup.update({ where: { id: groupId }, data: { budgetMode: input.budgetMode, budgetTimezone: input.budgetTimezone } })
      // An unused period can adopt its new timezone, but existing request history is never rewritten.
      const target = await this.period(db, { ...group, budgetMode: input.budgetMode, budgetTimezone: input.budgetTimezone }, new Date())
      await db.groupBudgetPeriod.update({ where: { id: target.id }, data: { timezone: input.budgetTimezone } })
      return this.adjustment(db, actor, period, input, 'LIMIT_ADJUSTMENT', { operationFingerprint: operation.hash, scope: 'CONFIG',
        before: { budgetMode: group.budgetMode, budgetTimezone: group.budgetTimezone }, after: { budgetMode: input.budgetMode, budgetTimezone: input.budgetTimezone } })
    })
  }

  async reconcile(actor: AuthPrincipal, groupId: string, entryId: string, input: { operationId: string; actualCny: string; reason: string; action: 'SETTLE' | 'RELEASE'; routes?: Array<{ id: string; costCny: string }> }) {
    this.assertAdmin(actor); const amount = cny(input.actualCny)
    if (!['SETTLE', 'RELEASE'].includes(input.action) || (input.action === 'RELEASE' && amount !== '0.00000000')) throw new BadRequestException('Release requires zero actual cost')
    const original = await this.prisma.groupBudgetEntry.findFirst({ where: { id: entryId, groupId, organizationId: actor.organizationId, kind: 'REQUEST' } })
    if (!original) throw new NotFoundException('Budget request not found')
    return this.locked(reference(original), async (db, entry, period) => {
      const operation = await this.operation(db, actor, groupId, input, { ...input, entryId, actualCny: amount })
      if (operation.existing) return operation.existing
      if (!['SETTLED', 'RECONCILIATION_REQUIRED'].includes(entry.status)) throw conflict()
      const log = await db.usageLog.findUnique({ where: { requestId: entry.requestId! }, include: { routes: true } })
      const snapshot = object(entry.snapshot)
      if (log && (log.organizationId !== entry.organizationId || log.accountId !== entry.accountId || log.groupId !== entry.groupId)) throw conflict()
      // Per-route corrections need an explicit allocation; do not invent a split across suppliers.
      const routeCosts = input.routes ?? (log?.routes.length === 1 ? [{ id: log.routes[0].id, costCny: amount }] : [])
      if (log?.routes.length || routeCosts.length) {
        if (!log || routeCosts.length !== log.routes.length || new Set(routeCosts.map(r => r.id)).size !== routeCosts.length ||
          routeCosts.some(r => !log.routes.some(original => original.id === r.id)) ||
          !routeCosts.reduce((sum, r) => sum.plus(cny(r.costCny)), new Decimal(0)).eq(amount)) throw conflict()
      }
      if (log) {
        await db.usageLog.update({ where: { id: log.id }, data: { costUsd: amount,
          costSnapshot: { ...(log.costSnapshot as Prisma.JsonObject ?? {}), billingState: input.action === 'RELEASE' ? 'NO_CHARGE' : 'CONFIRMED' } } })
        for (const route of routeCosts) await db.routeAttempt.update({ where: { id: route.id }, data: { costCny: route.costCny, billingState: input.action === 'RELEASE' ? 'NO_CHARGE' : 'CONFIRMED' } })
      } else {
        const usage = object(snapshot.request!).usage as Prisma.JsonObject | undefined
        if (!usage || usage.requestId !== entry.requestId || usage.organizationId !== entry.organizationId || usage.accountId !== entry.accountId || usage.groupId !== entry.groupId ||
          usage.credentialType !== entry.credentialType || (entry.credentialType === 'API_KEY' ? usage.apiKeyId : usage.deviceId) !== entry.credentialId) throw new ConflictException('Request log snapshot is missing; cannot reconcile safely')
        await db.usageLog.create({ data: { ...usage as unknown as Prisma.UsageLogUncheckedCreateInput, costUsd: amount } })
      }
      const previous = entry.settledCny.toString()
      await db.groupBudgetPeriod.update({ where: { id: period.id }, data: { spentCny: { increment: new Decimal(amount).minus(previous).toFixed(8) },
        ...(entry.status === 'RECONCILIATION_REQUIRED' ? { reservedCny: { decrement: entry.reservedCny } } : {}) } })
      await db.groupBudgetEntry.update({ where: { id: entry.id }, data: { status: input.action === 'RELEASE' ? 'RELEASED' : 'SETTLED', settledCny: amount,
        leaseUntil: null, reason: input.reason, snapshot: { ...snapshot, manualFinal: true,
          redisCorrection: { operationId: input.operationId, version: Number((snapshot.redisCorrection as Prisma.JsonObject | undefined)?.version ?? 0) + 1,
            costMicroUsd: Math.ceil(new Decimal(amount).times(1_000_000).toNumber()) }, redisSynced: false,
          ...(!snapshot.redisActual ? { redisActual: { tokens: log ? Number(log.inputTokens + log.outputTokens) : 0, costMicroUsd: Math.ceil(new Decimal(amount).times(1_000_000).toNumber()) } } : {}) } } })
      await this.alert(db, period.id)
      return this.adjustment(db, actor, period, input, 'COST_ADJUSTMENT', { operationFingerprint: operation.hash, requestEntryId: entry.id,
        before: { settledCny: previous, status: entry.status, costSnapshot: log?.costSnapshot ?? null, routes: log?.routes.map(r => ({ id: r.id, costCny: r.costCny?.toFixed(8) ?? null, billingState: r.billingState })) ?? [] },
        after: { settledCny: amount, action: input.action, routes: routeCosts } })
    })
  }

  private async period(db: Db, group: UsageGroup, at: Date) {
    const periodKey = budgetPeriodKey(group.budgetMode, group.budgetTimezone, at)
    const period = await db.groupBudgetPeriod.upsert({ where: { groupId_periodKey: { groupId: group.id, periodKey } }, update: {},
      create: { organizationId: group.organizationId, groupId: group.id, periodKey, timezone: group.budgetTimezone,
        unlimited: group.unlimited, limitCny: group.defaultLimitCny } })
    await db.$queryRaw`SELECT id FROM group_budget_periods WHERE id = ${period.id}::uuid FOR UPDATE`
    return period
  }

  private checkFunds(period: GroupBudgetPeriod, amount: string) {
    if (!period.unlimited && (period.limitCny.isZero() || new Decimal(availableCny(period.limitCny.toString(), period.spentCny.toString(), period.reservedCny.toString())).lt(amount))) {
      throw new HttpException({ code: 'group_budget_exceeded', message: 'Group budget is insufficient' }, 429)
    }
  }

  private async alert(db: Db, periodId: string) {
    const period = await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: periodId } })
    const used = new Decimal(period.spentCny.toString()).plus(period.reservedCny.toString())
    const threshold = period.unlimited ? 0 : used.gte(period.limitCny.toString()) ? 100 : used.gte(new Decimal(period.limitCny.toString()).times('0.8')) ? 80 : 0
    if (threshold > period.alertedThreshold) {
      await db.groupBudgetPeriod.update({ where: { id: periodId }, data: { alertedThreshold: threshold } })
      await db.auditLog.create({ data: { organizationId: period.organizationId, action: 'GROUP_BUDGET_THRESHOLD',
        resourceType: 'group_budget_period', resourceId: period.id, metadata: { groupId: period.groupId, threshold } } })
    }
    return !period.unlimited && period.spentCny.gt(period.limitCny)
  }

  private async locked<T>(ref: BudgetReservation, change: (db: Db, entry: GroupBudgetEntry, period: GroupBudgetPeriod) => Promise<T>) {
    const original = await this.prisma.groupBudgetEntry.findUnique({ where: { id: ref.id } })
    if (!original || original.kind !== 'REQUEST' || original.requestId !== ref.requestId || original.periodId !== ref.periodId || original.groupId !== ref.groupId) throw new NotFoundException('Budget request not found')
    return this.prisma.$transaction(async db => {
      await lockUsageGroup(db, original.organizationId, original.groupId)
      await db.$queryRaw`SELECT id FROM group_budget_periods WHERE id = ${original.periodId}::uuid FOR UPDATE`
      await db.$queryRaw`SELECT id FROM group_budget_entries WHERE id = ${original.id}::uuid FOR UPDATE`
      return change(db, await db.groupBudgetEntry.findUniqueOrThrow({ where: { id: original.id } }),
        await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: original.periodId } }))
    })
  }

  async reserve(input: { requestId: string; identity: GatewayIdentity & { groupId: string }; startedAt: Date; estimateCny: string; snapshot: Prisma.InputJsonObject }): Promise<BudgetReservation> {
    const amount = cny(input.estimateCny)
    const hash = fingerprint({ ...input, estimateCny: amount })
    const identity = input.identity
    return this.prisma.$transaction(async db => {
      const group = await lockUsageGroup(db, identity.organizationId, identity.groupId)
      await assertActiveGroupMember(db, { organizationId: identity.organizationId, groupId: identity.groupId, accountId: identity.sub })
      if (identity.credentialType === 'API_KEY') {
        const key = await db.employeeApiKey.findFirst({ where: { id: identity.apiKeyId, organizationId: identity.organizationId,
          accountId: identity.sub, groupId: identity.groupId, revokedAt: null, deletedAt: null, disabledAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true } })
        if (!key) throw new UnauthorizedException({ code: 'invalid_api_key', message: 'Employee API key is inactive' })
      }
      const existing = await db.groupBudgetEntry.findUnique({ where: { operationId: `request:${input.requestId}` } })
      if (existing) {
        if (object(existing.snapshot).reservationFingerprint !== hash || existing.status !== 'RESERVED') throw conflict()
        return reference(existing)
      }
      const period = await this.period(db, group, input.startedAt)
      this.checkFunds(period, amount)
      await db.groupBudgetPeriod.update({ where: { id: period.id }, data: { reservedCny: { increment: amount } } })
      const entry = await db.groupBudgetEntry.create({ data: { organizationId: identity.organizationId, groupId: group.id, periodId: period.id,
        requestId: input.requestId, operationId: `request:${input.requestId}`, kind: 'REQUEST', status: 'RESERVED', accountId: identity.sub,
        credentialType: identity.credentialType, credentialId: identity.apiKeyId ?? identity.deviceId, reservedCny: amount,
        startedAt: input.startedAt, leaseUntil: new Date(Date.now() + 60_000),
        snapshot: { request: input.snapshot, initialEstimateCny: amount, reservationFingerprint: hash, extensions: [] } } })
      await this.alert(db, period.id)
      return reference(entry)
    })
  }

  async extend(ref: BudgetReservation, additionalCny: string, attemptSnapshot: Prisma.InputJsonObject) {
    const amount = cny(additionalCny)
    if (typeof attemptSnapshot.attemptId !== 'string' || !attemptSnapshot.attemptId) throw conflict()
    return this.locked(ref, async (db, entry, period) => {
      if (entry.status !== 'RESERVED' && entry.status !== 'RECONCILIATION_REQUIRED') throw conflict()
      const snapshot = object(entry.snapshot)
      const extensions = (snapshot.extensions ?? []) as Prisma.JsonObject[]
      const hash = fingerprint({ amount, attemptSnapshot })
      const existing = extensions.find(item => item.attemptId === attemptSnapshot.attemptId)
      if (existing) { if (existing.hash !== hash) throw conflict(); return reference(entry) }
      this.checkFunds(period, amount)
      await db.groupBudgetPeriod.update({ where: { id: period.id }, data: { reservedCny: { increment: amount } } })
      const updated = await db.groupBudgetEntry.update({ where: { id: entry.id }, data: { reservedCny: { increment: amount },
        snapshot: { ...snapshot, extensions: [...extensions, { ...attemptSnapshot, amount, hash }] } } })
      await this.alert(db, period.id)
      return reference(updated)
    })
  }

  async settle(ref: BudgetReservation, input: { actualCny: string; usage: Prisma.UsageLogUncheckedCreateInput }): Promise<{ exceeded: boolean }> {
    const amount = cny(input.actualCny)
    const hash = fingerprint({ ...input.usage, costUsd: amount })
    return this.locked(ref, async (db, entry, period) => {
      const snapshot = object(entry.snapshot)
      if (snapshot.manualFinal) throw conflict()
      if (entry.status === 'SETTLED') {
        if (snapshot.settlementFingerprint !== hash) throw conflict()
        return { exceeded: snapshot.exceeded === true }
      }
      if (entry.status !== 'RESERVED' && entry.status !== 'RECONCILIATION_REQUIRED') throw conflict()
      const usage = input.usage
      this.assertUsage(entry, usage, amount)
      const existing = await db.usageLog.findUnique({ where: { requestId: entry.requestId! } })
      if (existing) {
        this.assertUsage(entry, existing, entry.settledCny.toString())
        if (!snapshot.holdFingerprint) throw conflict()
        await db.usageLog.update({ where: { id: existing.id }, data: { ...usage, costUsd: amount,
          ...(usage.routes ? { routes: { deleteMany: {}, ...usage.routes } } : {}) } })
      } else await db.usageLog.create({ data: { ...usage, costUsd: amount } })
      await db.groupBudgetPeriod.update({ where: { id: period.id }, data: { spentCny: { increment: new Decimal(amount).minus(entry.settledCny.toString()).toFixed(8) }, reservedCny: { decrement: entry.reservedCny } } })
      const exceeded = await this.alert(db, period.id)
      await db.groupBudgetEntry.update({ where: { id: entry.id }, data: { status: 'SETTLED', settledCny: amount, leaseUntil: null,
        snapshot: { ...snapshot, settlementFingerprint: hash, exceeded, redisActual: this.redisActual(usage, amount), redisSynced: false } } })
      return { exceeded }
    })
  }

  private assertUsage(entry: GroupBudgetEntry, usage: Pick<Prisma.UsageLogUncheckedCreateInput, 'requestId' | 'organizationId' | 'accountId' | 'groupId' | 'credentialType' | 'apiKeyId' | 'deviceId' | 'costUsd'>, amount: string) {
    if (usage.requestId !== entry.requestId || usage.organizationId !== entry.organizationId || usage.accountId !== entry.accountId ||
      usage.groupId !== entry.groupId || usage.credentialType !== entry.credentialType ||
      (entry.credentialType === 'API_KEY' ? usage.apiKeyId : usage.deviceId) !== entry.credentialId || !new Decimal(String(usage.costUsd ?? '0')).eq(amount)) throw conflict()
  }

  private redisActual(usage: Prisma.UsageLogUncheckedCreateInput, amount: string) {
    return { tokens: Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0), costMicroUsd: Math.ceil(new Decimal(amount).times(1_000_000).toNumber()) }
  }

  async hold(ref: BudgetReservation, input: { actualCny: string; unresolvedCny: string; usage: Prisma.UsageLogUncheckedCreateInput; reason: string }) {
    const amount = cny(input.actualCny); const unresolved = cny(input.unresolvedCny); const hash = fingerprint(input)
    return this.locked(ref, async (db, entry, period) => {
      const snapshot = object(entry.snapshot)
      if (snapshot.holdFingerprint === hash) return
      if (snapshot.manualFinal || snapshot.holdFingerprint || !['RESERVED', 'RECONCILIATION_REQUIRED'].includes(entry.status)) throw conflict()
      this.assertUsage(entry, input.usage, amount)
      await db.usageLog.create({ data: input.usage })
      await db.groupBudgetPeriod.update({ where: { id: period.id }, data: {
        spentCny: { increment: amount }, reservedCny: { increment: new Decimal(unresolved).minus(entry.reservedCny.toString()).toFixed(8) } } })
      await db.groupBudgetEntry.update({ where: { id: entry.id }, data: { status: 'RECONCILIATION_REQUIRED', settledCny: amount,
        reservedCny: unresolved, reason: input.reason, leaseUntil: null, snapshot: { ...snapshot, holdFingerprint: hash } } })
      await this.alert(db, period.id)
    })
  }

  async syncQuota(ref: BudgetReservation, quota: RedisQuotaService) {
    const entry = await this.prisma.groupBudgetEntry.findUniqueOrThrow({ where: { id: ref.id } })
    const snapshot = object(entry.snapshot)
    if (snapshot.redisSynced || !['SETTLED', 'RELEASED'].includes(entry.status)) return
    const reservations = (object(snapshot.request!).redis ?? []) as any[]
    const actual = snapshot.redisActual as { tokens: number; costMicroUsd: number } | undefined
    const correction = snapshot.redisCorrection as { operationId: string; costMicroUsd: number; version: number } | undefined
    for (const reservation of reservations) {
      if (actual) await quota.settle(reservation, actual)
      else await quota.release(reservation)
      if (correction) await quota.correctCost(reservation, correction.costMicroUsd, correction.operationId, correction.version)
    }
    await this.locked(ref, async (db, current) => {
      // A concurrent manual correction must remain pending for the next recovery pass.
      if (fingerprint(object(current.snapshot).redisCorrection) === fingerprint(snapshot.redisCorrection)) {
        await db.groupBudgetEntry.update({ where: { id: current.id }, data: { snapshot: { ...object(current.snapshot), redisSynced: true } } })
      }
    })
  }

  async recoverQuota(quota: RedisQuotaService, now: Date) {
    let failed = 0
    const entries = await this.prisma.groupBudgetEntry.findMany({ where: { kind: 'REQUEST', status: { in: ['SETTLED', 'RELEASED'] },
      snapshot: { path: ['redisSynced'], equals: false } }, take: 100, orderBy: { updatedAt: 'asc' } })
    for (const entry of entries) {
      try { await this.syncQuota(reference(entry), quota) } catch { failed++ }
    }
    for (const reservation of await quota.expiredReservations(now)) {
      try {
        const entry = await this.prisma.groupBudgetEntry.findUnique({ where: { operationId: `request:${reservation.requestId}` } })
        if (!entry) await quota.release(reservation)
        else if (['SETTLED', 'RELEASED'].includes(entry.status)) await this.syncQuota(reference(entry), quota)
        else if (entry.status === 'RECONCILIATION_REQUIRED') await quota.releaseConcurrency(reservation)
      } catch { failed++ }
    }
    return { failed }
  }

  async release(ref: BudgetReservation, reason: string) {
    return this.locked(ref, async (db, entry) => {
      if (entry.status === 'RELEASED') return
      if (entry.status !== 'RESERVED' || entry.dispatchedAt) throw conflict()
      await this.releaseEntry(db, entry, reason)
    })
  }

  private async releaseEntry(db: Db, entry: GroupBudgetEntry, reason: string) {
    await db.groupBudgetPeriod.update({ where: { id: entry.periodId }, data: { reservedCny: { decrement: entry.reservedCny } } })
    await db.groupBudgetEntry.update({ where: { id: entry.id }, data: { status: 'RELEASED', reason, leaseUntil: null, snapshot: { ...object(entry.snapshot), redisSynced: false } } })
  }

  async markDispatched(ref: BudgetReservation, leaseUntil: Date, attempt?: Prisma.InputJsonObject) {
    return this.locked(ref, async (db, entry) => {
      if (entry.status !== 'RESERVED') throw conflict()
      const snapshot = object(entry.snapshot)
      const intents = (snapshot.dispatchIntents ?? []) as Prisma.JsonObject[]
      await db.groupBudgetEntry.update({ where: { id: entry.id }, data: { dispatchedAt: entry.dispatchedAt ?? new Date(), leaseUntil,
        ...(attempt ? { snapshot: { ...snapshot, dispatchIntents: [...intents.filter(item => item.attemptId !== attempt.attemptId), attempt] } } : {}) } })
    })
  }

  async markUncertain(ref: BudgetReservation, reason: string) {
    return this.locked(ref, async (db, entry) => {
      if (entry.status === 'SETTLED' || entry.status === 'RELEASED') return
      await db.groupBudgetEntry.update({ where: { id: entry.id }, data: { status: 'RECONCILIATION_REQUIRED', reason, leaseUntil: null } })
    })
  }

  async recoverExpired(now: Date): Promise<{ released: number; uncertain: number }> {
    const entries = await this.prisma.groupBudgetEntry.findMany({ where: { kind: 'REQUEST', status: 'RESERVED', leaseUntil: { lte: now } }, take: 100, orderBy: { leaseUntil: 'asc' } })
    const counts = { released: 0, uncertain: 0 }
    for (const original of entries) {
      const recovered = await this.locked(reference(original), async (db, entry) => {
        if (entry.status !== 'RESERVED' || !entry.leaseUntil || entry.leaseUntil > now) return null
        if (entry.dispatchedAt) {
          await db.groupBudgetEntry.update({ where: { id: entry.id }, data: { status: 'RECONCILIATION_REQUIRED', reason: 'Expired dispatched request', leaseUntil: null } })
          return 'uncertain' as const
        }
        await this.releaseEntry(db, entry, 'Expired before dispatch')
        return 'released' as const
      })
      if (recovered) counts[recovered]++
    }
    return counts
  }
}
