import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { Prisma, type Project, type ProjectBudgetEntry, type ProjectBudgetPeriod } from '@prisma/client'
import { createHash } from 'node:crypto'
import Decimal from 'decimal.js'
import { PrismaService } from '../../database/src/prisma.service.js'
import type { GatewayIdentity } from '../../security/src/gateway-auth.js'
import type { AuthPrincipal } from '../../security/src/auth.js'
import { availableCny, budgetPeriodKey, cny } from './group-budget.js'
import type { RedisQuotaService } from './redis-quota.js'
import { readProjectBudgets } from './project-budget-read.js'

export type ProjectBudgetReservation = { id: string; requestId: string; periodId: string; projectId: string; reservedCny: string }
export type ProjectGatewayIdentity = GatewayIdentity & { projectId: string; groupId: string }
type Db = Prisma.TransactionClient
type ProjectWithRegion = Project & { region: {
  id: string; type: string; orgType: string; enabled: boolean; archivedAt: Date | null
} }

const object = (value: Prisma.JsonValue) => value as Prisma.JsonObject
// The same canonical fingerprint rules as the group ledger: retries are comparable without retaining bodies or secrets.
function fingerprint(value: unknown): string {
  const canonical = (v: any): any => v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() :
    Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().filter(key => v[key] !== undefined).map(key => [key, canonical(v[key])]))
      : v
  return createHash('sha256').update(JSON.stringify(canonical(value ?? null))).digest('hex')
}
const conflict = () => new ConflictException('Budget operation conflicts with the recorded state')
const reference = (entry: ProjectBudgetEntry): ProjectBudgetReservation => ({ id: entry.id, requestId: entry.requestId!, periodId: entry.periodId,
  projectId: entry.projectId, reservedCny: entry.reservedCny.toFixed(8) })

@Injectable()
export class ProjectBudgetService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(actor: AuthPrincipal) {
    if (!['PLATFORM_ADMIN', 'ORG_ADMIN'].includes(actor.role)) throw new ForbiddenException('Administrator required')
  }

  private async lockProject(db: Db, organizationId: string, projectId: string): Promise<ProjectWithRegion> {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM projects WHERE id = ${projectId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE
    `
    if (!rows.length) throw new NotFoundException('Project not found')
    return db.project.findUniqueOrThrow({ where: { id: projectId }, include: {
      region: { select: { id: true, type: true, orgType: true, enabled: true, archivedAt: true } }
    } }) as Promise<ProjectWithRegion>
  }

  private assertReservable(project: ProjectWithRegion) {
    const ownerValid = project.category === 'DEPARTMENT'
      ? ['FUNCTIONAL', 'EXECUTIVE'].includes(project.region.orgType)
      : project.region.type === 'REGION'
    if (project.status !== 'ACTIVE' || !ownerValid || !project.region.enabled || project.region.archivedAt) {
      throw new ForbiddenException({ code: 'project_unavailable', message: 'Project is unavailable' })
    }
  }

  private async assertCanApply(db: Db, actor: AuthPrincipal, project: ProjectWithRegion) {
    if (['PLATFORM_ADMIN', 'ORG_ADMIN'].includes(actor.role)) return
    const projectMember = await db.projectMember.findFirst({ where: {
      projectId: project.id, accountId: actor.sub,
      ...(project.category === 'DEPARTMENT' ? {} : { role: 'OWNER' as const }),
      membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } }
    }, select: { projectId: true } })
    if (projectMember) return
    if (project.category === 'DEPARTMENT') {
      const head = await db.groupMember.findFirst({ where: {
        groupId: project.regionId, accountId: actor.sub, role: 'LEADER', removedAt: null,
        membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } }
      }, select: { groupId: true } })
      if (head) return
    }
    throw new ForbiddenException({ code: 'budget_applicant_forbidden', message: 'Project owner or department head required' })
  }

  async summary(actor: AuthPrincipal, projectId: string) {
    this.assertAdmin(actor)
    const summary = (await readProjectBudgets(this.prisma, actor.organizationId, [projectId])).get(projectId)
    if (!summary) throw new NotFoundException('Project not found')
    return summary
  }

  async entries(actor: AuthPrincipal, projectId: string, query: { offset: number; limit: number }) {
    await this.summary(actor, projectId)
    const where = { organizationId: actor.organizationId, projectId }
    const [items, total] = await Promise.all([
      this.prisma.projectBudgetEntry.findMany({ where, skip: query.offset, take: query.limit, orderBy: [{ startedAt: 'desc' }, { id: 'asc' }] }),
      this.prisma.projectBudgetEntry.count({ where })
    ])
    return { items, total, ...query }
  }

  private async operation(db: Db, actor: AuthPrincipal, projectId: string, input: { operationId: string; reason: string }, payload: unknown) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId) ||
      !input.reason?.trim() || input.reason.length > 2000) {
      throw new BadRequestException('Operation UUID and reason (1–2000 characters) are required')
    }
    const hash = fingerprint({ projectId, actor: actor.sub, payload })
    const existing = await db.projectBudgetEntry.findUnique({ where: { operationId: input.operationId } })
    if (existing && (existing.organizationId !== actor.organizationId || object(existing.snapshot).operationFingerprint !== hash)) throw conflict()
    return { existing, hash }
  }

  private async adjustment(db: Db, actor: AuthPrincipal, period: ProjectBudgetPeriod,
    input: { operationId: string; reason: string }, snapshot: Prisma.InputJsonObject) {
    const entry = await db.projectBudgetEntry.create({ data: {
      organizationId: actor.organizationId, projectId: period.projectId, periodId: period.id,
      operationId: input.operationId, kind: 'LIMIT_ADJUSTMENT', status: 'SETTLED', reason: input.reason,
      actorAccountId: actor.sub, snapshot
    } })
    await db.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub,
      action: 'PROJECT_BUDGET_LIMIT_ADJUSTMENT', resourceType: 'project_budget_entry', resourceId: entry.id, metadata: snapshot } })
    return entry
  }

  async adjust(actor: AuthPrincipal, projectId: string, input: {
    operationId: string; limitCny: string; unlimited: boolean; reason: string; applicationId?: string
  }) {
    this.assertAdmin(actor)
    const amount = cny(input.limitCny)
    if (typeof input.unlimited !== 'boolean') throw new BadRequestException('Invalid unlimited flag')
 return this.prisma.$transaction(async db => this.adjustInTransaction(db, actor, projectId, input), { timeout: 15_000 })
  }

  private async adjustInTransaction(db: Db, actor: AuthPrincipal, projectId: string, input: {
    operationId: string; limitCny: string; unlimited: boolean; reason: string; applicationId?: string
  }) {
    const amount = cny(input.limitCny)
    const project = await this.lockProject(db, actor.organizationId, projectId)
    const operation = await this.operation(db, actor, projectId, input, { ...input, limitCny: amount })
    if (operation.existing) return operation.existing
    if (project.status === 'ARCHIVED') throw conflict()
    let application: { id: string; applicantAccountId: string } | null = null
    if (input.applicationId) {
      application = await db.projectBudgetApplication.findFirst({ where: {
        id: input.applicationId, organizationId: actor.organizationId, projectId
      }, select: { id: true, applicantAccountId: true } })
      if (!application) throw new NotFoundException('Budget application not found')
      const decided = await db.projectBudgetApplication.findUnique({ where: { id: application.id }, select: { status: true } })
      if (decided?.status !== 'REGISTERED') throw conflict()
    }
    const period = await this.period(db, project, new Date())
    await db.$queryRaw`SELECT id FROM project_budget_periods WHERE id = ${period.id}::uuid FOR UPDATE`
    const before = { limitCny: period.limitCny.toFixed(8), unlimited: period.unlimited }
    if (!input.unlimited && new Decimal(amount).lt(new Decimal(period.spentCny.toString()).plus(period.reservedCny.toString()))) {
      throw conflict()
    }
    await db.projectBudgetPeriod.update({ where: { id: period.id }, data: { limitCny: amount, unlimited: input.unlimited } })
    await this.alert(db, period.id)
    const entry = await this.adjustment(db, actor, period, input, { operationFingerprint: operation.hash,
      before, after: { limitCny: amount, unlimited: input.unlimited }, ...(input.applicationId ? { applicationId: input.applicationId } : {}) })
    if (application) {
      await db.projectBudgetApplication.update({ where: { id: application.id }, data: {
        status: 'LINKED', approvedCny: amount, decidedById: actor.sub, decidedAt: new Date(),
        linkedEntryId: entry.id, selfApproved: application.applicantAccountId === actor.sub
      } })
    }
    return entry
  }

  async applications(actor: AuthPrincipal, projectId: string, query: { offset: number; limit: number }) {
    this.assertAdmin(actor)
    const project = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: actor.organizationId }, select: { id: true } })
    if (!project) throw new NotFoundException('Project not found')
    const where = { organizationId: actor.organizationId, projectId }
    const [items, total] = await Promise.all([
      this.prisma.projectBudgetApplication.findMany({ where, skip: query.offset, take: query.limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: { applicant: { select: { account: { select: { displayName: true } } } } } }),
      this.prisma.projectBudgetApplication.count({ where })
    ])
    return { items, total, ...query }
  }

  async createApplication(actor: AuthPrincipal, projectId: string, input: {
    requestedCny: string; reason: string; applicantAccountId?: string
  }) {
    const amount = cny(input.requestedCny)
    if (new Decimal(amount).lte(0)) throw new BadRequestException('Requested amount must be greater than zero')
    if (!input.reason?.trim() || input.reason.length > 2000) throw new BadRequestException('Reason (1–2000 characters) is required')
    return this.prisma.$transaction(async db => {
      const project = await this.lockProject(db, actor.organizationId, projectId)
      if (project.status === 'ARCHIVED') throw conflict()
      await this.assertCanApply(db, actor, project)
      const applicantAccountId = input.applicantAccountId || actor.sub
      const applicant = await db.membership.findFirst({ where: {
        organizationId: actor.organizationId, accountId: applicantAccountId, status: 'ACTIVE'
      } })
      if (!applicant) throw new ForbiddenException('Active organization member required')
      const application = await db.projectBudgetApplication.create({ data: {
        organizationId: actor.organizationId, projectId, applicantAccountId, requestedCny: amount, reason: input.reason
      } })
      await db.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub,
        action: 'PROJECT_BUDGET_APPLICATION_REGISTER', resourceType: 'project_budget_application',
        resourceId: application.id, metadata: { projectId, requestedCny: amount } } })
      return application
    })
  }

  async submitAndApprove(actor: AuthPrincipal, projectId: string, input: {
    operationId: string; requestedTotalCny: string; unlimited: boolean; reason: string
  }) {
    if (actor.role !== 'PLATFORM_ADMIN') throw new ForbiddenException('Platform administrator required')
    const amount = cny(input.requestedTotalCny)
    if (new Decimal(amount).lte(0)) throw new BadRequestException('Requested total must be greater than zero')
    return this.prisma.$transaction(async db => {
      const project = await this.lockProject(db, actor.organizationId, projectId)
      if (project.status === 'ARCHIVED') throw conflict()
      const application = await db.projectBudgetApplication.create({ data: {
        organizationId: actor.organizationId, projectId, applicantAccountId: actor.sub,
        requestedCny: amount, reason: input.reason
      } })
      await db.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub,
        action: 'PROJECT_BUDGET_APPLICATION_REGISTER', resourceType: 'project_budget_application',
        resourceId: application.id, metadata: { projectId, requestedCny: amount, selfApproved: true } } })
      return this.adjustInTransaction(db, actor, projectId, {
        ...input, limitCny: amount, applicationId: application.id
      })
    }, { timeout: 15_000 })
  }

  async rejectApplication(actor: AuthPrincipal, projectId: string, applicationId: string, note?: string) {
    this.assertAdmin(actor)
    if (note !== undefined && note.length > 2000) throw new BadRequestException('Decision note is too long')
    return this.prisma.$transaction(async db => {
      const project = await this.lockProject(db, actor.organizationId, projectId)
      if (project.status === 'ARCHIVED') throw conflict()
      const result = await db.projectBudgetApplication.updateMany({ where: {
        organizationId: actor.organizationId, projectId, id: applicationId, status: 'REGISTERED'
      }, data: { status: 'REJECTED', decidedById: actor.sub, decidedAt: new Date(), ...(note ? { decisionNote: note } : {}) } })
      if (!result.count) {
        const application = await db.projectBudgetApplication.findFirst({ where: {
          organizationId: actor.organizationId, projectId, id: applicationId
        } })
        if (!application) throw new NotFoundException('Budget application not found')
        throw conflict()
      }
      await db.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub,
        action: 'PROJECT_BUDGET_APPLICATION_REJECT', resourceType: 'project_budget_application',
        resourceId: applicationId, metadata: { projectId } } })
      return { id: applicationId, status: 'REJECTED' as const }
    })
  }

  private async period(db: Db, project: Project, at: Date) {
    const periodKey = budgetPeriodKey(project.budgetMode, project.budgetTimezone, at)
    const period = await db.projectBudgetPeriod.upsert({ where: { projectId_periodKey: { projectId: project.id, periodKey } }, update: {},
      create: { organizationId: project.organizationId, projectId: project.id, periodKey, timezone: project.budgetTimezone } })
    await db.$queryRaw`SELECT id FROM project_budget_periods WHERE id = ${period.id}::uuid FOR UPDATE`
    return period
  }

  private checkFunds(period: ProjectBudgetPeriod, amount: string) {
    if (!period.unlimited && (period.limitCny.isZero() ||
      new Decimal(availableCny(period.limitCny.toString(), period.spentCny.toString(), period.reservedCny.toString())).lt(amount))) {
      throw new HttpException({ code: 'project_budget_exceeded', message: 'Project budget exceeded' }, 429)
    }
  }

  private async alert(db: Db, periodId: string) {
    const period = await db.projectBudgetPeriod.findUniqueOrThrow({ where: { id: periodId } })
    const used = new Decimal(period.spentCny.toString()).plus(period.reservedCny.toString())
    const threshold = period.unlimited ? 0 : used.gte(period.limitCny.toString()) ? 100
      : used.gte(new Decimal(period.limitCny.toString()).times('0.8')) ? 80 : 0
    if (threshold > period.alertedThreshold) {
      await db.projectBudgetPeriod.update({ where: { id: periodId }, data: { alertedThreshold: threshold } })
      await db.auditLog.create({ data: { organizationId: period.organizationId, action: 'PROJECT_BUDGET_THRESHOLD',
        resourceType: 'project_budget_period', resourceId: period.id, metadata: { projectId: period.projectId, threshold } } })
    }
    return !period.unlimited && period.spentCny.gt(period.limitCny)
  }

  private async locked<T>(ref: ProjectBudgetReservation,
    change: (db: Db, entry: ProjectBudgetEntry, period: ProjectBudgetPeriod) => Promise<T>) {
    const original = await this.prisma.projectBudgetEntry.findUnique({ where: { id: ref.id } })
    if (!original || original.kind !== 'REQUEST' || original.requestId !== ref.requestId ||
      original.periodId !== ref.periodId || original.projectId !== ref.projectId) throw new NotFoundException('Budget request not found')
    return this.prisma.$transaction(async db => {
      await this.lockProject(db, original.organizationId, original.projectId)
      await db.$queryRaw`SELECT id FROM project_budget_periods WHERE id = ${original.periodId}::uuid FOR UPDATE`
      await db.$queryRaw`SELECT id FROM project_budget_entries WHERE id = ${original.id}::uuid FOR UPDATE`
      return change(db, await db.projectBudgetEntry.findUniqueOrThrow({ where: { id: original.id } }),
        await db.projectBudgetPeriod.findUniqueOrThrow({ where: { id: original.periodId } }))
    })
  }

  async reserve(input: {
    requestId: string; identity: ProjectGatewayIdentity; startedAt: Date; estimateCny: string; snapshot: Prisma.InputJsonObject
  }): Promise<ProjectBudgetReservation> {
    const amount = cny(input.estimateCny)
    const hash = fingerprint({ ...input, estimateCny: amount })
    const identity = input.identity
    return this.prisma.$transaction(async db => {
      const project = await this.lockProject(db, identity.organizationId, identity.projectId)
      this.assertReservable(project)
      if (project.regionId !== identity.groupId) throw new ForbiddenException({ code: 'project_unavailable', message: 'Project is unavailable' })
      const projectMember = await db.projectMember.findFirst({ where: {
        projectId: project.id, accountId: identity.sub, role: { not: 'VIEWER' },
        membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } }
      }, select: { projectId: true } })
      if (!projectMember) throw new ForbiddenException({ code: 'project_member_required', message: 'Active project member required' })
      if (identity.credentialType === 'API_KEY') {
        const key = await db.employeeApiKey.findFirst({ where: {
          id: identity.apiKeyId, organizationId: identity.organizationId, accountId: identity.sub,
          groupId: project.regionId, projectId: project.id, revokedAt: null, deletedAt: null, disabledAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
        }, select: { id: true } })
        if (!key) throw new UnauthorizedException({ code: 'invalid_api_key', message: 'Employee API key is inactive' })
      } else {
        const device = await db.device.findFirst({ where: {
          id: identity.deviceId, organizationId: identity.organizationId, accountId: identity.sub, revokedAt: null,
          grant: { projectId: project.id, groupId: project.regionId, disabledAt: null, deletedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }
        }, select: { id: true } })
        if (!device) throw new UnauthorizedException({ code: 'invalid_device', message: 'Device project grant is inactive' })
      }
      const existing = await db.projectBudgetEntry.findUnique({ where: { operationId: `request:${input.requestId}` } })
      if (existing) {
        if (object(existing.snapshot).reservationFingerprint !== hash || existing.status !== 'RESERVED') throw conflict()
        return reference(existing)
      }
      const period = await this.period(db, project, input.startedAt)
      this.checkFunds(period, amount)
      await db.projectBudgetPeriod.update({ where: { id: period.id }, data: { reservedCny: { increment: amount } } })
      const entry = await db.projectBudgetEntry.create({ data: {
        organizationId: identity.organizationId, projectId: project.id, periodId: period.id,
        requestId: input.requestId, operationId: `request:${input.requestId}`, kind: 'REQUEST', status: 'RESERVED',
        accountId: identity.sub, credentialType: identity.credentialType,
        credentialId: identity.apiKeyId ?? identity.deviceId, reservedCny: amount, startedAt: input.startedAt,
        leaseUntil: new Date(Date.now() + 60_000),
        snapshot: { request: input.snapshot, regionId: project.regionId, initialEstimateCny: amount, reservationFingerprint: hash, extensions: [] }
      } })
      await this.alert(db, period.id)
      return reference(entry)
    }, { timeout: 15_000 })
  }

  async extend(ref: ProjectBudgetReservation, additionalCny: string, attemptSnapshot: Prisma.InputJsonObject) {
    const amount = cny(additionalCny)
    if (typeof attemptSnapshot.attemptId !== 'string' || !attemptSnapshot.attemptId) throw conflict()
    return this.locked(ref, async (db, entry, period) => {
      if (entry.status !== 'RESERVED' && entry.status !== 'RECONCILIATION_REQUIRED') throw conflict()
      const snapshot = object(entry.snapshot)
      const extensions = (snapshot.extensions ?? []) as Prisma.JsonObject[]
      const hash = fingerprint({ amount, attemptSnapshot })
      const existing = extensions.find(item => item.attemptId === attemptSnapshot.attemptId)
      if (existing) {
        if (existing.hash !== hash) throw conflict()
        return reference(entry)
      }
      this.checkFunds(period, amount)
      await db.projectBudgetPeriod.update({ where: { id: period.id }, data: { reservedCny: { increment: amount } } })
      const updated = await db.projectBudgetEntry.update({ where: { id: entry.id }, data: {
        reservedCny: { increment: amount },
        snapshot: { ...snapshot, extensions: [...extensions, { ...attemptSnapshot, amount, hash }] }
      } })
      await this.alert(db, period.id)
      return reference(updated)
    })
  }

  async settle(ref: ProjectBudgetReservation, input: { actualCny: string; usage: Prisma.UsageLogUncheckedCreateInput }): Promise<{ exceeded: boolean }> {
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
      this.assertUsage(entry, usage, amount, String(snapshot.regionId))
      const existing = await db.usageLog.findUnique({ where: { requestId: entry.requestId! } })
      if (existing) {
        this.assertUsage(entry, existing, entry.settledCny.toString(), String(snapshot.regionId))
        if (!snapshot.holdFingerprint) throw conflict()
        await db.usageLog.update({ where: { id: existing.id }, data: { ...usage, costUsd: amount,
          ...(usage.routes ? { routes: { deleteMany: {}, ...usage.routes } } : {}) } })
      } else await db.usageLog.create({ data: { ...usage, costUsd: amount } })
      await db.projectBudgetPeriod.update({ where: { id: period.id }, data: {
        spentCny: { increment: new Decimal(amount).minus(entry.settledCny.toString()).toFixed(8) },
        reservedCny: { decrement: entry.reservedCny }
      } })
      const exceeded = await this.alert(db, period.id)
      await db.projectBudgetEntry.update({ where: { id: entry.id }, data: {
        status: 'SETTLED', settledCny: amount, leaseUntil: null,
        snapshot: { ...snapshot, settlementFingerprint: hash, exceeded, redisActual: this.redisActual(usage, amount), redisSynced: false }
      } })
      return { exceeded }
    })
  }

  private assertUsage(entry: ProjectBudgetEntry, usage: Pick<Prisma.UsageLogUncheckedCreateInput,
    'requestId' | 'organizationId' | 'accountId' | 'groupId' | 'budgetProjectId' | 'credentialType' | 'apiKeyId' | 'deviceId' | 'costUsd'>, amount: string, regionId: string) {
    if (usage.requestId !== entry.requestId || usage.organizationId !== entry.organizationId || usage.accountId !== entry.accountId ||
      usage.groupId !== regionId || usage.budgetProjectId !== entry.projectId ||
      usage.credentialType !== entry.credentialType ||
      (entry.credentialType === 'API_KEY' ? usage.apiKeyId : usage.deviceId) !== entry.credentialId ||
      !new Decimal(String(usage.costUsd ?? '0')).eq(amount)) throw conflict()
  }

  private redisActual(usage: Prisma.UsageLogUncheckedCreateInput, amount: string) {
    return { tokens: Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0),
      costMicroUsd: Math.ceil(new Decimal(amount).times(1_000_000).toNumber()) }
  }

  async hold(ref: ProjectBudgetReservation, input: {
    actualCny: string; unresolvedCny: string; usage: Prisma.UsageLogUncheckedCreateInput; reason: string
  }) {
    const amount = cny(input.actualCny)
    const unresolved = cny(input.unresolvedCny)
    const hash = fingerprint(input)
    return this.locked(ref, async (db, entry, period) => {
      const snapshot = object(entry.snapshot)
      if (snapshot.holdFingerprint === hash) return
      if (snapshot.manualFinal || snapshot.holdFingerprint || !['RESERVED', 'RECONCILIATION_REQUIRED'].includes(entry.status)) throw conflict()
      this.assertUsage(entry, input.usage, amount, String(snapshot.regionId))
      await db.usageLog.create({ data: input.usage })
      await db.projectBudgetPeriod.update({ where: { id: period.id }, data: {
        spentCny: { increment: amount },
        reservedCny: { increment: new Decimal(unresolved).minus(entry.reservedCny.toString()).toFixed(8) }
      } })
      await db.projectBudgetEntry.update({ where: { id: entry.id }, data: {
        status: 'RECONCILIATION_REQUIRED', settledCny: amount, reservedCny: unresolved, reason: input.reason,
        leaseUntil: null, snapshot: { ...snapshot, holdFingerprint: hash }
      } })
      await this.alert(db, period.id)
    })
  }

  async syncQuota(ref: ProjectBudgetReservation, quota: RedisQuotaService) {
    const entry = await this.prisma.projectBudgetEntry.findUniqueOrThrow({ where: { id: ref.id } })
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
      if (fingerprint(object(current.snapshot).redisCorrection) === fingerprint(snapshot.redisCorrection)) {
        await db.projectBudgetEntry.update({ where: { id: current.id }, data: {
          snapshot: { ...object(current.snapshot), redisSynced: true }
        } })
      }
    })
  }

  async recoverQuota(quota: RedisQuotaService, now: Date) {
    let failed = 0
    const entries = await this.prisma.projectBudgetEntry.findMany({ where: {
      kind: 'REQUEST', status: { in: ['SETTLED', 'RELEASED'] }, snapshot: { path: ['redisSynced'], equals: false }
    }, take: 100, orderBy: { updatedAt: 'asc' } })
    for (const entry of entries) {
      try { await this.syncQuota(reference(entry), quota) } catch { failed++ }
    }
    for (const reservation of await quota.expiredReservations(now)) {
      try {
        const entry = await this.prisma.projectBudgetEntry.findUnique({ where: { operationId: `request:${reservation.requestId}` } })
        if (!entry) await quota.release(reservation)
        else if (['SETTLED', 'RELEASED'].includes(entry.status)) await this.syncQuota(reference(entry), quota)
        else if (entry.status === 'RECONCILIATION_REQUIRED') await quota.releaseConcurrency(reservation)
      } catch { failed++ }
    }
    return { failed }
  }

  async release(ref: ProjectBudgetReservation, reason: string) {
    return this.locked(ref, async (db, entry) => {
      if (entry.status === 'RELEASED') return
      if (entry.status !== 'RESERVED' || entry.dispatchedAt) throw conflict()
      await this.releaseEntry(db, entry, reason)
    })
  }

  private async releaseEntry(db: Db, entry: ProjectBudgetEntry, reason: string) {
    await db.projectBudgetPeriod.update({ where: { id: entry.periodId }, data: { reservedCny: { decrement: entry.reservedCny } } })
    await db.projectBudgetEntry.update({ where: { id: entry.id }, data: {
      status: 'RELEASED', reason, leaseUntil: null, snapshot: { ...object(entry.snapshot), redisSynced: false }
    } })
  }

  async markDispatched(ref: ProjectBudgetReservation, leaseUntil: Date, attempt?: Prisma.InputJsonObject) {
    return this.locked(ref, async (db, entry) => {
      if (entry.status !== 'RESERVED') throw conflict()
      const snapshot = object(entry.snapshot)
      const intents = (snapshot.dispatchIntents ?? []) as Prisma.JsonObject[]
      await db.projectBudgetEntry.update({ where: { id: entry.id }, data: {
        dispatchedAt: entry.dispatchedAt ?? new Date(), leaseUntil,
        ...(attempt ? { snapshot: { ...snapshot, dispatchIntents: [...intents.filter(item => item.attemptId !== attempt.attemptId), attempt] } } : {})
      } })
    })
  }

  async markUncertain(ref: ProjectBudgetReservation, reason: string) {
    return this.locked(ref, async (db, entry) => {
      if (entry.status === 'SETTLED' || entry.status === 'RELEASED') return
      await db.projectBudgetEntry.update({ where: { id: entry.id }, data: {
        status: 'RECONCILIATION_REQUIRED', reason, leaseUntil: null
      } })
    })
  }

  async recoverExpired(now: Date): Promise<{ released: number; uncertain: number }> {
    const entries = await this.prisma.projectBudgetEntry.findMany({ where: {
      kind: 'REQUEST', status: 'RESERVED', leaseUntil: { lte: now }
    }, take: 100, orderBy: { leaseUntil: 'asc' } })
    const counts = { released: 0, uncertain: 0 }
    for (const original of entries) {
      const recovered = await this.locked(reference(original), async (db, entry) => {
        if (entry.status !== 'RESERVED' || !entry.leaseUntil || entry.leaseUntil > now) return null
        if (entry.dispatchedAt) {
          await db.projectBudgetEntry.update({ where: { id: entry.id }, data: {
            status: 'RECONCILIATION_REQUIRED', reason: 'Expired dispatched request', leaseUntil: null
          } })
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
