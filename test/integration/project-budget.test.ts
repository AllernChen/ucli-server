import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { ProjectBudgetService } from '../../packages/quota/src/project-budget.service.js'
import { readProjectBudgets } from '../../packages/quota/src/project-budget-read.js'
import { createOrganization, withTestDatabase } from './database.js'

async function fixture(db: PrismaClient, limit = '1') {
  const { organization, account, actor } = await createOrganization(db)
  const region = await db.usageGroup.create({ data: {
    organizationId: organization.id, name: '华南区域', type: 'REGION'
  } })
  await db.groupMember.create({ data: { organizationId: organization.id, groupId: region.id, accountId: account.id } })
  const project = await db.project.create({ data: {
    organizationId: organization.id, regionId: region.id, code: 'AI-PLATFORM', name: 'AI 平台', budgetMode: 'TOTAL'
  } })
  const key = await db.employeeApiKey.create({ data: {
    organizationId: organization.id, groupId: region.id, projectId: project.id, accountId: account.id,
    name: '项目 Key', secretHash: randomUUID(), secretHint: '…test', createdById: account.id
  } })
  const channel = await db.channel.create({ data: { name: randomUUID(), provider: 'test', protocol: 'OPENAI', baseUrl: 'https://example.invalid' } })
  const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: '项目模型' } })
  const service = new ProjectBudgetService(db as PrismaService)
  await service.adjust(actor, project.id, { operationId: randomUUID(), limitCny: limit, unlimited: false, reason: '设置项目总额' })
  const startedAt = new Date('2026-09-30T15:59:59Z')
  const identity = { ...actor, groupId: region.id, projectId: project.id, credentialType: 'API_KEY' as const, apiKeyId: key.id }
  const usageBase = { requestId: randomUUID(), organizationId: organization.id, accountId: account.id,
    groupId: region.id, budgetProjectId: project.id, projectId: project.id, credentialType: 'API_KEY' as const, apiKeyId: key.id,
    actorSnapshot: { employeeName: '测试员工', groupName: '华南区域', projectName: 'AI 平台', keyName: '项目 Key', keyHint: '…test' },
    publicModelId: model.id, upstreamModel: 'upstream', channelId: channel.id, protocol: 'OPENAI_CHAT' as const,
    startedAt, finishedAt: new Date('2026-10-01T00:00:00Z'), durationMs: 1, usageSource: 'UPSTREAM' as const,
    streaming: false, statusCode: 200 }
  const usage = (requestId: string, costUsd: string) => ({ ...usageBase, requestId, costUsd, inputTokens: 3, outputTokens: 5 })
  const reserve = (requestId = randomUUID(), estimateCny = '0.2') =>
    service.reserve({ requestId, identity, startedAt, estimateCny, snapshot: { usage: { ...usageBase, requestId } } })
  return { db, service, actor, organization, region, project, key, identity, usageBase, usage, reserve, startedAt }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('project budget (PostgreSQL)', () => {
  it('exposes the project budget API and provider', () => {
    const controller = readFileSync(join(process.cwd(), 'apps/api/src/projects.controller.ts'), 'utf8')
    const module = readFileSync(join(process.cwd(), 'apps/api/src/app.module.ts'), 'utf8')
    for (const route of [
      "@Get(':id/budget')", "@Get(':id/budget-entries')", "@Post(':id/budget-adjustments')",
      "@Get(':id/budget-applications')", "@Post(':id/budget-applications')", "@Post(':id/budget-applications/:applicationId/decision')"
    ]) expect(controller).toContain(route)
    expect(module).toContain('ProjectBudgetService')
  })

  it('reserves, settles and releases a total-period project budget', async () => {
    await withTestDatabase(async db => {
      const f = await fixture(db)
      expect(await f.service.summary(f.actor, f.project.id)).toMatchObject({
        periodId: expect.any(String), periodKey: 'TOTAL', budgetMode: 'TOTAL', unlimited: false,
        limitCny: '1.00000000', spentCny: '0.00000000', reservedCny: '0.00000000', availableCny: '1.00000000'
      })

      const reservation = await f.reserve()
      const summary = await f.service.summary(f.actor, f.project.id)
      expect(summary).toMatchObject({ spentCny: '0.00000000', reservedCny: '0.20000000', availableCny: '0.80000000' })
      const reservedEntry = await db.projectBudgetEntry.findUniqueOrThrow({ where: { id: reservation.id } })
      expect(reservedEntry).toMatchObject({ projectId: f.project.id, periodId: reservation.periodId, kind: 'REQUEST', status: 'RESERVED' })
      expect(reservedEntry.reservedCny.toFixed(8)).toBe('0.20000000')

      await f.service.settle(reservation, { actualCny: '0.15', usage: f.usage(reservation.requestId, '0.15') })
      expect(await f.service.summary(f.actor, f.project.id)).toMatchObject({ spentCny: '0.15000000', reservedCny: '0.00000000' })
      const log = await db.usageLog.findUniqueOrThrow({ where: { requestId: reservation.requestId } })
      expect(log).toMatchObject({ groupId: f.region.id, budgetProjectId: f.project.id })
      expect(log.costUsd.toFixed(8)).toBe('0.15000000')

      const transient = await f.reserve()
      await f.service.release(transient, 'Cancelled before dispatch')
      expect(await f.service.summary(f.actor, f.project.id)).toMatchObject({ spentCny: '0.15000000', reservedCny: '0.00000000' })
      await expect(db.projectBudgetEntry.findUniqueOrThrow({ where: { id: transient.id } })).resolves.toMatchObject({ status: 'RELEASED' })
    })
  }, 30_000)

  it('rejects insufficient funds with a project-specific 429 and deduplicates retries', async () => {
    await withTestDatabase(async db => {
      const f = await fixture(db)
      const requestId = randomUUID()
      const reservation = await f.reserve(requestId)
      await expect(f.service.reserve({
        requestId: randomUUID(), identity: f.identity, startedAt: f.startedAt, estimateCny: '2',
        snapshot: { usage: f.usageBase }
      })).rejects.toMatchObject({ status: 429, response: { code: 'project_budget_exceeded', message: 'Project budget exceeded' } })
      await expect(f.reserve(requestId)).resolves.toEqual(reservation)
    })
  }, 30_000)

  it('makes idempotent limit adjustments and writes an auditable PROJECT ledger entry', async () => {
    await withTestDatabase(async db => {
      const f = await fixture(db)
      const input = { operationId: randomUUID(), limitCny: '2', unlimited: false, reason: '批复项目二期总额' }
      const entry = await f.service.adjust(f.actor, f.project.id, input)
      expect(entry).toMatchObject({ kind: 'LIMIT_ADJUSTMENT', status: 'SETTLED', projectId: f.project.id })
      await expect(f.service.adjust(f.actor, f.project.id, input)).resolves.toEqual(entry)
      expect(await f.service.summary(f.actor, f.project.id)).toMatchObject({ limitCny: '2.00000000', availableCny: '2.00000000' })
      await expect(db.auditLog.findFirstOrThrow({ where: { resourceId: entry.id } }))
        .resolves.toMatchObject({ action: 'PROJECT_BUDGET_LIMIT_ADJUSTMENT', resourceType: 'project_budget_entry' })
      const { items, total } = await f.service.entries(f.actor, f.project.id, { offset: 0, limit: 10 })
      expect(total).toBeGreaterThanOrEqual(2)
      expect(items.some(item => item.id === entry.id)).toBe(true)
    })
  }, 30_000)

  it('uses the project timezone and keeps a monthly reservation in its starting period', async () => {
    await withTestDatabase(async db => {
      const f = await fixture(db)
      await db.project.update({ where: { id: f.project.id }, data: { budgetMode: 'MONTHLY', budgetTimezone: 'Asia/Shanghai' } })
      await f.service.adjust(f.actor, f.project.id, { operationId: randomUUID(), limitCny: '1', unlimited: false, reason: '设置月度额度' })
      const reservation = await f.reserve()
      const summaries = await readProjectBudgets(f.db, f.organization.id, [f.project.id], new Date('2026-10-01T00:00:00Z'))
      expect(summaries.get(f.project.id)).toMatchObject({ periodKey: '2026-10', periodId: null, limitCny: '0.00000000' })
      await f.service.settle(reservation, { actualCny: '0.15', usage: f.usage(reservation.requestId, '0.15') })
      const october = await readProjectBudgets(f.db, f.organization.id, [f.project.id], new Date('2026-10-01T00:00:00Z'))
      expect(october.get(f.project.id)).toMatchObject({ periodKey: '2026-10', periodId: null, spentCny: '0.00000000' })
      expect((await f.service.entries(f.actor, f.project.id, { offset: 0, limit: 10 })).items[0].periodId).toBe(reservation.periodId)
    })
  }, 30_000)

  it('marks dispatched leases uncertain and releases undispatched leases after expiry', async () => {
    await withTestDatabase(async db => {
      const f = await fixture(db, '2')
      const dispatched = await f.reserve()
      await f.service.markDispatched(dispatched, new Date('2026-09-30T15:59:00Z'), { attemptId: randomUUID() })
      const transient = await f.reserve()
      const result = await f.service.recoverExpired(new Date('2026-09-30T16:00:00Z'))
      expect(result.released).toBeGreaterThanOrEqual(1)
      expect(result.uncertain).toBeGreaterThanOrEqual(1)
      await expect(db.projectBudgetEntry.findUniqueOrThrow({ where: { id: dispatched.id } }))
        .resolves.toMatchObject({ status: 'RECONCILIATION_REQUIRED' })
      await expect(db.projectBudgetEntry.findUniqueOrThrow({ where: { id: transient.id } }))
        .resolves.toMatchObject({ status: 'RELEASED' })
      expect(await f.service.summary(f.actor, f.project.id)).toMatchObject({ reservedCny: '0.20000000', uncertainCny: '0.20000000' })
    })
  }, 30_000)

  it('extends reservations idempotently and holds uncertain settled cost', async () => {
    await withTestDatabase(async db => {
      const f = await fixture(db, '2')
      const reservation = await f.reserve()
      const attempt = { attemptId: randomUUID(), channelId: f.usageBase.channelId }
      await f.service.extend(reservation, '0.3', attempt)
      await expect(f.service.extend(reservation, '0.3', attempt)).resolves.toMatchObject({ reservedCny: '0.50000000' })
      await f.service.markDispatched(reservation, new Date('2026-09-30T16:00:00Z'))
      await f.service.hold(reservation, {
        actualCny: '0.2', unresolvedCny: '0.6', reason: 'Upstream timeout',
        usage: f.usage(reservation.requestId, '0.2')
      })
      expect(await f.service.summary(f.actor, f.project.id)).toMatchObject({ spentCny: '0.20000000', reservedCny: '0.60000000', uncertainCny: '0.60000000' })
      await f.service.settle(reservation, { actualCny: '0.45', usage: f.usage(reservation.requestId, '0.45') })
      expect(await f.service.summary(f.actor, f.project.id)).toMatchObject({ spentCny: '0.45000000', reservedCny: '0.00000000', uncertainCny: '0.00000000' })
    })
  }, 30_000)

  it('rejects suspended and archived projects before reservation', async () => {
    await withTestDatabase(async db => {
      const f = await fixture(db)
      await db.project.update({ where: { id: f.project.id }, data: { status: 'SUSPENDED' } })
      await expect(f.reserve()).rejects.toMatchObject({ status: 403, response: { code: 'project_unavailable' } })
      await db.project.update({ where: { id: f.project.id }, data: { status: 'ARCHIVED' } })
      await expect(f.reserve()).rejects.toMatchObject({ status: 403, response: { code: 'project_unavailable' } })
    })
  }, 30_000)

  it('links an approved application to the post-approval total and rejects decided applications', async () => {
    await withTestDatabase(async db => {
      const f = await fixture(db, '0')
      const application = await f.service.createApplication(f.actor, f.project.id, {
        requestedCny: '3', reason: '项目启动预算'
      })
      const entry = await f.service.adjust(f.actor, f.project.id, {
        operationId: randomUUID(), limitCny: '3', unlimited: false, reason: '批复总额', applicationId: application.id
      })
      const linked = await db.projectBudgetApplication.findUniqueOrThrow({ where: { id: application.id } })
      expect(linked).toMatchObject({ status: 'LINKED', decidedById: f.actor.sub, linkedEntryId: entry.id })
      expect(linked.approvedCny?.toFixed(8)).toBe('3.00000000')
      const rejected = await f.service.createApplication(f.actor, f.project.id, { requestedCny: '1', reason: '追加' })
      await f.service.rejectApplication(f.actor, f.project.id, rejected.id, '额度不足')
      await expect(db.projectBudgetApplication.findUniqueOrThrow({ where: { id: rejected.id } }))
        .resolves.toMatchObject({ status: 'REJECTED', decisionNote: '额度不足' })
      await expect(f.service.applications(f.actor, f.project.id, { offset: 0, limit: 10 })).resolves.toMatchObject({ total: 2 })
      await expect(f.service.adjust(f.actor, f.project.id, {
        operationId: randomUUID(), limitCny: '1', unlimited: false, reason: '重复批复', applicationId: rejected.id
      })).rejects.toMatchObject({ status: 409 })
    })
  }, 30_000)

  it('rejects non-administrators and cross-organization projects', async () => {
    await withTestDatabase(async db => {
      const f = await fixture(db)
      const other = await createOrganization(db)
      await expect(f.service.summary({ ...f.actor, role: 'MEMBER' }, f.project.id)).rejects.toMatchObject({ status: 403 })
      await expect(f.service.entries({ ...f.actor, role: 'MEMBER' }, f.project.id, { offset: 0, limit: 10 })).rejects.toMatchObject({ status: 403 })
      await expect(f.service.adjust({ ...f.actor, role: 'MEMBER' }, f.project.id, {
        operationId: randomUUID(), limitCny: '1', unlimited: false, reason: '无权限'
      })).rejects.toMatchObject({ status: 403 })
      await expect(f.service.summary(other.actor, f.project.id)).rejects.toMatchObject({ status: 404 })
      await expect(f.service.adjust(other.actor, f.project.id, {
        operationId: randomUUID(), limitCny: '1', unlimited: false, reason: '跨组织'
      })).rejects.toMatchObject({ status: 404 })
    })
  }, 30_000)
})
