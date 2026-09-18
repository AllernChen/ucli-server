import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { GroupBudgetService } from '../../packages/quota/src/group-budget.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { LedGroupsService } from '../../apps/api/src/led-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('budget applications (PostgreSQL)', () => {
  async function seed(db: PrismaClient) {
    const owner = await createOrganization(db)
    const groups = new UsageGroupsService(db as PrismaService)
    const budget = new GroupBudgetService(db as PrismaService)
    const led = new LedGroupsService(db as PrismaService)
    const group = await groups.create(owner.actor, { name: 'App project', type: 'PROJECT' })
    const other = await groups.create(owner.actor, { name: 'Other project', type: 'PROJECT' })
    const leader = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: 'Leader' } })
    const member = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: 'Member' } })
    for (const account of [leader, member]) {
      await db.membership.create({ data: { organizationId: owner.organization.id, accountId: account.id, role: 'MEMBER' } })
      await groups.addMember(owner.actor, group.id, account.id)
    }
    await groups.setLeader(owner.actor, group.id, leader.id, true)
    const leaderActor = { organizationId: owner.organization.id, sub: leader.id, role: 'MEMBER' as const, tokenVersion: 1 }
    const memberActor = { organizationId: owner.organization.id, sub: member.id, role: 'MEMBER' as const, tokenVersion: 1 }
    return { owner, groups, budget, led, group, other, leader, member, leaderActor, memberActor }
  }

  it('lets a leader submit applications and keeps them pending', async () => {
    await withTestDatabase(async db => {
      const s = await seed(db)
      const application = await s.led.submitApplication(s.leaderActor, s.group.id, { requestedCny: '5000', reason: '项目二期启动预算' })
      expect(application).toMatchObject({ status: 'REGISTERED', applicantAccountId: s.leader.id, requestedCny: expect.anything() })
      const listed = await s.led.applications(s.leaderActor, s.group.id, {})
      expect(listed).toMatchObject({ total: 1 })
      expect(listed.items[0]).toMatchObject({ id: application.id, status: 'REGISTERED' })

      await expect(s.led.submitApplication(s.memberActor, s.group.id, { requestedCny: '1', reason: 'x'.repeat(10) })).rejects.toMatchObject({ status: 403 })
      await expect(s.led.submitApplication(s.leaderActor, s.group.id, { requestedCny: '0', reason: 'zero' })).rejects.toMatchObject({ status: 400 })
      await expect(s.led.submitApplication(s.leaderActor, s.group.id, { requestedCny: '-5', reason: 'negative' })).rejects.toMatchObject({ status: 400 })
      expect((await s.led.applications(s.leaderActor, s.group.id, {})).total).toBe(1)
    })
  }, 30_000)

  it('links an approval adjustment to the application atomically', async () => {
    await withTestDatabase(async db => {
      const s = await seed(db)
      const application = await s.led.submitApplication(s.leaderActor, s.group.id, { requestedCny: '5000', reason: '首期预算' })
      const entry = await s.budget.adjust(s.owner.actor, s.group.id, {
        operationId: randomUUID(), scope: 'CURRENT', limitCny: '5000', unlimited: false,
        reason: '批复首期预算', applicationId: application.id
      })
      const stored = await db.groupBudgetApplication.findUniqueOrThrow({ where: { id: application.id } })
      expect(stored).toMatchObject({ status: 'LINKED', approvedCny: expect.anything(), decidedById: s.owner.account.id, linkedEntryId: entry.id })
      expect(stored.decidedAt).not.toBeNull()
      expect((await db.groupBudgetPeriod.findUniqueOrThrow({ where: { groupId_periodKey: { groupId: s.group.id, periodKey: 'TOTAL' } } })).limitCny.toFixed(0)).toBe('5000')

      await expect(s.budget.adjust(s.owner.actor, s.group.id, {
        operationId: randomUUID(), scope: 'CURRENT', limitCny: '6000', unlimited: false, reason: '重复批复', applicationId: application.id
      })).rejects.toMatchObject({ status: 409 })
    })
  }, 30_000)

  it('rejects foreign applications, non-current scopes and decided applications', async () => {
    await withTestDatabase(async db => {
      const s = await seed(db)
      const application = await s.led.submitApplication(s.leaderActor, s.group.id, { requestedCny: '1000', reason: '追加' })
      await expect(s.budget.adjust(s.owner.actor, s.other.id, {
        operationId: randomUUID(), scope: 'CURRENT', limitCny: '1000', unlimited: false, reason: '他组', applicationId: application.id
      })).rejects.toMatchObject({ status: 404 })
      await expect(s.budget.adjust(s.owner.actor, s.group.id, {
        operationId: randomUUID(), scope: 'DEFAULT', limitCny: '1000', unlimited: false, reason: '默认周期', applicationId: application.id
      })).rejects.toMatchObject({ status: 400 })

      await s.groups.rejectApplication(s.owner.actor, s.group.id, application.id, '金额超预算盘子')
      const rejected = await db.groupBudgetApplication.findUniqueOrThrow({ where: { id: application.id } })
      expect(rejected).toMatchObject({ status: 'REJECTED', decidedById: s.owner.account.id, decisionNote: '金额超预算盘子' })
      expect(rejected.linkedEntryId).toBeNull()
      await expect(s.groups.rejectApplication(s.owner.actor, s.group.id, application.id)).rejects.toMatchObject({ status: 409 })
      await expect(s.budget.adjust(s.owner.actor, s.group.id, {
        operationId: randomUUID(), scope: 'CURRENT', limitCny: '1000', unlimited: false, reason: '驳回后批复', applicationId: application.id
      })).rejects.toMatchObject({ status: 409 })
    })
  }, 30_000)

  it('keeps legacy adjustments untouched and records admin-created applications', async () => {
    await withTestDatabase(async db => {
      const s = await seed(db)
      const plain = await s.budget.adjust(s.owner.actor, s.group.id, {
        operationId: randomUUID(), scope: 'CURRENT', limitCny: '3000', unlimited: false, reason: '直接调整不带申请'
      })
      expect(plain.kind).toBe('LIMIT_ADJUSTMENT')
      const registered = await s.groups.createApplication(s.owner.actor, s.group.id, {
        requestedCny: '800', reason: '代登记：线下已批', applicantAccountId: s.member.id
      })
      expect(registered).toMatchObject({ status: 'REGISTERED', applicantAccountId: s.member.id })
      const entries = await s.budget.entries(s.owner.actor, s.group.id, { offset: 0, limit: 10 })
      expect(entries.items.some(item => (item.snapshot as any)?.applicationId === undefined)).toBe(true)
      await expect(s.groups.applications(s.owner.actor.organizationId, s.group.id)).resolves.toMatchObject({ total: 1 })
    })
  }, 30_000)
})
