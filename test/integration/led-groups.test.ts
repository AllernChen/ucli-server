import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Prisma, PrismaClient } from '@prisma/client'
import { LedGroupsService } from '../../apps/api/src/led-groups.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('led groups portal (PostgreSQL)', () => {
  async function seed(db: PrismaClient) {
    const owner = await createOrganization(db)
    const service = new UsageGroupsService(db as PrismaService)
    const ledGroupsService = new LedGroupsService(db as PrismaService)
    const group = await service.create(owner.actor, { name: 'Led project', type: 'PROJECT' })
    const other = await service.create(owner.actor, { name: 'Other project', type: 'PROJECT' })
    const leader = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: 'Leader' } })
    const member = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: 'Member' } })
    const outsider = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: 'Outsider' } })
    for (const account of [leader, member, outsider]) {
      await db.membership.create({ data: { organizationId: owner.organization.id, accountId: account.id, role: 'MEMBER' } })
    }
    await service.addMember(owner.actor, group.id, leader.id)
    await service.addMember(owner.actor, group.id, member.id)
    await service.addMember(owner.actor, other.id, outsider.id)
    await service.setLeader(owner.actor, group.id, leader.id, true)
    const channel = await db.channel.create({ data: { name: 'ch', provider: 'p', protocol: 'OPENAI', baseUrl: 'http://upstream' } })
    const model = await db.publicModel.create({ data: { id: `model-${randomUUID()}`, displayName: 'Model A' } })
    const memberKey = await db.employeeApiKey.create({ data: { organizationId: owner.organization.id, groupId: group.id,
      accountId: member.id, createdById: owner.account.id, name: 'Member key', secretHash: randomUUID(), secretHint: 'mk' } })
    const outsiderKey = await db.employeeApiKey.create({ data: { organizationId: owner.organization.id, groupId: other.id,
      accountId: outsider.id, createdById: owner.account.id, name: 'Outsider key', secretHash: randomUUID(), secretHint: 'ok' } })
    const at = new Date()
    const log = (data: Partial<Prisma.UsageLogUncheckedCreateInput>) => db.usageLog.create({ data: {
      requestId: randomUUID(), organizationId: owner.organization.id, accountId: member.id,
      credentialType: 'API_KEY', apiKeyId: memberKey.id, groupId: group.id,
      publicModelId: model.id, upstreamModel: 'upstream',
      channelId: channel.id, protocol: 'OPENAI_CHAT', startedAt: at, finishedAt: at, durationMs: 10,
      statusCode: 200, costUsd: '1.5', usageSource: 'UPSTREAM', streaming: false,
      inputTokens: 100, outputTokens: 20, cachedTokens: 0, reasoningTokens: 0, ...data
    } })
    return { owner, service, ledGroupsService, group, other, leader, member, outsider, model, memberKey, outsiderKey, log }
  }

  const webActor = (seeded: Awaited<ReturnType<typeof seed>>, account: { id: string }) =>
    ({ organizationId: seeded.owner.organization.id, sub: account.id, role: 'MEMBER' as const, tokenVersion: 1 })

  it('lists only led groups with budget summaries for the leader', async () => {
    await withTestDatabase(async db => {
      const s = await seed(db)
      const listed = await s.ledGroupsService.list(webActor(s, s.leader))
      expect(listed.map(item => item.name)).toEqual(['Led project'])
      expect(listed[0]).toMatchObject({ budget: expect.objectContaining({ budgetMode: 'TOTAL' }) })
      expect(await s.ledGroupsService.list(webActor(s, s.member))).toEqual([])
    })
  }, 30_000)

  it('lets a leader read their own budget but not another group', async () => {
    await withTestDatabase(async db => {
      const s = await seed(db)
      await expect(s.ledGroupsService.budget(webActor(s, s.leader), s.group.id)).resolves.toMatchObject({ budgetMode: 'TOTAL' })
      await expect(s.ledGroupsService.budget(webActor(s, s.leader), s.other.id)).rejects.toMatchObject({ status: 403 })
      await expect(s.ledGroupsService.budget(webActor(s, s.member), s.group.id)).rejects.toMatchObject({ status: 403 })
    })
  }, 30_000)

  it('scopes group usage to the led group only', async () => {
    await withTestDatabase(async db => {
      const s = await seed(db)
      await s.log({ groupId: s.group.id })
      await s.log({ groupId: s.group.id, costUsd: '2' })
      await s.log({ groupId: s.other.id, accountId: s.outsider.id, apiKeyId: s.outsiderKey.id, costUsd: '99' })
      const usage = await s.ledGroupsService.usage(webActor(s, s.leader), s.group.id, {})
      expect(usage.overview).toMatchObject({ requests: 2, costCny: '3.50000000' })
      expect(usage.byAccount).toHaveLength(1)
      expect(usage.byAccount[0]).toMatchObject({ name: 'Member', requests: 2 })
      expect(usage.byModel[0]).toMatchObject({ name: 'Model A', requests: 2 })
      expect(usage.items).toHaveLength(2)
      expect(usage.items.every(item => item.accountName === 'Member')).toBe(true)
      await expect(s.ledGroupsService.usage(webActor(s, s.leader), s.other.id, {})).rejects.toMatchObject({ status: 403 })
    })
  }, 30_000)

  it('rejects device sessions and invalid ranges', async () => {
    await withTestDatabase(async db => {
      const s = await seed(db)
      const deviceActor = { ...webActor(s, s.leader), deviceId: 'device-id' }
      await expect(s.ledGroupsService.list(deviceActor)).rejects.toMatchObject({ status: 403, message: 'Web login required' })
      await expect(s.ledGroupsService.usage(webActor(s, s.leader), s.group.id, { start: '2026-09-18T00:00:00Z', end: '2026-09-18T00:00:00Z' }))
        .rejects.toMatchObject({ status: 400 })
      await expect(s.ledGroupsService.usage(webActor(s, s.leader), s.group.id, { start: '2026-01-01T00:00:00Z', end: '2026-09-18T00:00:00Z' }))
        .rejects.toMatchObject({ status: 400 })
    })
  }, 30_000)

  it('loses portal visibility after group removal', async () => {
    await withTestDatabase(async db => {
      const s = await seed(db)
      await s.service.removeMember(s.owner.actor, s.group.id, s.leader.id)
      expect(await s.ledGroupsService.list(webActor(s, s.leader))).toEqual([])
      await expect(s.ledGroupsService.budget(webActor(s, s.leader), s.group.id)).rejects.toMatchObject({ status: 403 })
    })
  }, 30_000)
})
