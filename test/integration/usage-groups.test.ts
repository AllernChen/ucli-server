import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectsService } from '../../apps/api/src/projects.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from './database.js'
import { DeviceGrantsService } from '../../apps/api/src/device-grants.service.js'
import { DeviceGrantLinksService } from '../../apps/api/src/device-grant-links.service.js'
import { createDeviceGrantLinkCredential } from '../../packages/security/src/device-grant-links.js'
import { UsageGroupPageQueryDto } from '../../apps/api/src/usage-groups.dto.js'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

describe.skipIf(!process.env.TEST_DATABASE_URL)('group management (PostgreSQL)', () => {
  it('validates risk filters', () => {
    expect(validateSync(plainToInstance(UsageGroupPageQueryDto, { budgetRisk: 'typo' }))).not.toEqual([])
    for (const budgetRisk of ['NEAR_LIMIT', 'EXHAUSTED', 'UNSETTLED', 'ATTENTION']) {
      expect(validateSync(plainToInstance(UsageGroupPageQueryDto, { budgetRisk }))).toEqual([])
    }
  })

  it('filters risk before pagination with true totals and severity, name, id ordering', () => withTestDatabase(async db => {
    const { actor } = await createOrganization(db); const other = await createOrganization(db)
    const service = new UsageGroupsService(db as PrismaService)
    const create = async (name: string, limit: string, spent = '0', reserved = '0', uncertain = '0', unlimited = false) => {
      const group = await db.usageGroup.create({ data: { organizationId: actor.organizationId, type: 'PROJECT', name, defaultLimitCny: '99', unlimited: !unlimited } })
      const period = await db.groupBudgetPeriod.create({ data: { organizationId: actor.organizationId, groupId: group.id,
        periodKey: 'TOTAL', timezone: 'Asia/Shanghai', limitCny: limit, spentCny: spent, reservedCny: reserved, unlimited } })
      if (uncertain !== '0') await db.groupBudgetEntry.create({ data: { organizationId: actor.organizationId, groupId: group.id, periodId: period.id,
        operationId: randomUUID(), requestId: randomUUID(), accountId: actor.sub, credentialType: 'DEVICE', credentialId: randomUUID(),
        kind: 'REQUEST', status: 'RECONCILIATION_REQUIRED', reservedCny: uncertain, snapshot: {} } })
      return group
    }
    const near = await create('A Near', '1', '0.79999999', '0.00000001')
    const exhausted = await create('Z Exhausted', '1', '0.9', '0.1', '0.1')
    const zero = await db.usageGroup.create({ data: { organizationId: actor.organizationId, name: 'A Zero', type: 'DEPARTMENT' } })
    const unsettled = await create('B Unsettled', '1', '0', '0.1', '0.1')
    const unlimited = await create('C Unlimited unsettled', '0', '9', '1', '1', true)
    const tie = await create('A Near', '1', '0.99999999')
    await create('Healthy', '1', '0.79999999')
    await create('Unlimited healthy', '0', '9', '0', '0', true)
    // At this scale Number rounds the occupied amount up to the limit.
    const precise = await create('Precision Near', '999999999999.99999999', '999999999999.99999998')
    const disabled = await create('Disabled', '0'); await db.usageGroup.update({ where: { id: disabled.id }, data: { enabled: false } })
    const archived = await create('Archived', '0'); await db.usageGroup.update({ where: { id: archived.id }, data: { archivedAt: new Date(), enabled: false } })
    await db.usageGroup.create({ data: { organizationId: other.actor.organizationId, name: 'Foreign', type: 'PROJECT' } })
    const list = (input: Partial<UsageGroupPageQueryDto>) => service.list(actor.organizationId, Object.assign(new UsageGroupPageQueryDto(), input))
    const attention = await list({ budgetRisk: 'ATTENTION', limit: 2 })
    expect(attention.total).toBe(7)
    expect(attention.items.map(g => g.id)).toEqual([zero.id, exhausted.id])
    expect((await list({ budgetRisk: 'ATTENTION', offset: 2, limit: 2 })).items.map(g => g.id)).toEqual([unsettled.id, unlimited.id])
    expect((await list({ budgetRisk: 'ATTENTION', offset: 4 })).items.map(g => g.id)).toEqual([...[near.id, tie.id].sort(), precise.id])
    expect(await list({ budgetRisk: 'ATTENTION', offset: 99 })).toMatchObject({ items: [], total: 7 })
    expect((await list({ budgetRisk: 'NEAR_LIMIT' })).items.map(g => g.id)).toEqual([...[near.id, tie.id].sort(), precise.id])
    expect((await list({ budgetRisk: 'EXHAUSTED' })).items.map(g => g.id)).toEqual([zero.id, exhausted.id])
    expect((await list({ budgetRisk: 'UNSETTLED' })).items.map(g => g.id)).toEqual([exhausted.id, unsettled.id, unlimited.id])
    expect(await list({ budgetRisk: 'ATTENTION', status: 'disabled' })).toMatchObject({ total: 1, items: [{ id: disabled.id }] })
    expect(await list({ budgetRisk: 'ATTENTION', status: 'archived' })).toMatchObject({ total: 1, items: [{ id: archived.id }] })
    expect(await list({ budgetRisk: 'ATTENTION', status: 'all' })).toMatchObject({ total: 9 })
    expect(await list({ budgetRisk: 'ATTENTION', type: 'DEPARTMENT' })).toMatchObject({ total: 1, items: [{ id: zero.id }] })
    expect(await list({ budgetRisk: 'ATTENTION', q: 'a nEAr' })).toMatchObject({ total: 2 })
    expect(await list({ budgetRisk: 'ATTENTION', q: "' OR 1=1 --" })).toMatchObject({ total: 0 })
    const ordinary = await list({})
    expect(ordinary.total).toBe(9)
    expect(ordinary.items.map(g => g.id)).toEqual((await db.usageGroup.findMany({ where: { organizationId: actor.organizationId, archivedAt: null, enabled: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] })).map(g => g.id))
    expect(attention.items[1]).toMatchObject({ budget: { limitCny: '1.00000000', defaultLimitCny: '99.00000000', unlimited: false,
      spentCny: '0.90000000', reservedCny: '0.10000000', uncertainCny: '0.10000000', availableCny: '0.00000000' }, activeMembers: 0, activeKeys: 0 })
  }))

  it.each([
    ['Asia/Shanghai', '2026-09-30T16:30:00Z', '2026-10'],
    ['America/New_York', '2026-09-30T16:30:00Z', '2026-09'],
    ['+08:00', '2026-09-30T16:30:00Z', '2026-10'],
    ['+08', '2026-09-30T16:30:00Z', '2026-10'],
    ['+0800', '2026-09-30T16:30:00Z', '2026-10'],
    ['-05:30', '2026-10-01T02:00:00Z', '2026-09']
  ])('matches current monthly risk and summary for %s', (budgetTimezone, time, periodKey) => withTestDatabase(async db => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(time))
    const { actor } = await createOrganization(db)
    const group = await db.usageGroup.create({ data: { organizationId: actor.organizationId, name: 'Month boundary', type: 'DEPARTMENT',
      budgetMode: 'MONTHLY', budgetTimezone, defaultLimitCny: '10' } })
    const period = await db.groupBudgetPeriod.create({ data: { organizationId: actor.organizationId, groupId: group.id,
      periodKey, timezone: budgetTimezone, limitCny: '1', spentCny: '1' } })
    await db.groupBudgetPeriod.create({ data: { organizationId: actor.organizationId, groupId: group.id,
      periodKey: periodKey === '2026-10' ? '2026-09' : '2026-10', timezone: budgetTimezone, limitCny: '10' } })
    const result = await new UsageGroupsService(db as PrismaService).list(actor.organizationId,
      Object.assign(new UsageGroupPageQueryDto(), { budgetRisk: 'EXHAUSTED' }))
    expect(result).toMatchObject({ total: 1, items: [{ id: group.id, budget: { periodId: period.id, periodKey, availableCny: '0.00000000' } }] })
  }))

  it('keeps the same month when the clock crosses a boundary between risk and summary queries', () => withTestDatabase(async db => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-30T15:59:59Z'))
    const { actor } = await createOrganization(db)
    const group = await db.usageGroup.create({ data: { organizationId: actor.organizationId, type: 'DEPARTMENT', name: 'Boundary',
      budgetMode: 'MONTHLY', defaultLimitCny: '2' } })
    await db.groupBudgetPeriod.create({ data: { organizationId: actor.organizationId, groupId: group.id,
      periodKey: '2026-09', timezone: 'Asia/Shanghai', limitCny: '1', spentCny: '1' } })
    const movingClock = db.$extends({ query: { usageGroup: { async findMany({ args, query }) {
      const result = await query(args)
      vi.setSystemTime(new Date('2026-09-30T16:00:00Z'))
      return result
    } } } })
    const result = await new UsageGroupsService(movingClock as unknown as PrismaService).list(actor.organizationId,
      Object.assign(new UsageGroupPageQueryDto(), { budgetRisk: 'EXHAUSTED' }))
    expect(result).toMatchObject({ total: 1, items: [{ id: group.id, budget: { periodKey: '2026-09', availableCny: '0.00000000' } }] })
    expect(await db.groupBudgetPeriod.count({ where: { groupId: group.id } })).toBe(1)
  }))

  it('counts active members using access relations and keys using revocation, disable and expiration', () => withTestDatabase(async db => {
    vi.useFakeTimers({ toFake: ['Date'] }); const now = new Date('2026-09-15T12:00:00Z'); vi.setSystemTime(now)
    const { actor } = await createOrganization(db)
    const service = new UsageGroupsService(db as PrismaService)
    const group = await service.create(actor, { name: 'Counts', type: 'PROJECT' })
    await service.addMember(actor, group.id, actor.sub)
    for (const state of ['removed', 'membershipDisabled', 'accountDisabled']) {
      const account = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: state,
        status: state === 'accountDisabled' ? 'DISABLED' : 'ACTIVE' } })
      await db.membership.create({ data: { organizationId: actor.organizationId, accountId: account.id, role: 'MEMBER',
        status: state === 'membershipDisabled' ? 'DISABLED' : 'ACTIVE' } })
      await db.groupMember.create({ data: { organizationId: actor.organizationId, groupId: group.id, accountId: account.id,
        removedAt: state === 'removed' ? now : null } })
    }
    for (const data of [{}, { expiresAt: new Date(now.getTime() + 1) }, { expiresAt: now }, { revokedAt: now }, { disabledAt: now }, { deletedAt: now }]) {
      await db.employeeApiKey.create({ data: { organizationId: actor.organizationId, groupId: group.id, accountId: actor.sub,
        createdById: actor.sub, name: 'Key', secretHash: randomUUID(), secretHint: 'test', ...data } })
    }
    const read = async () => (await service.list(actor.organizationId, Object.assign(new UsageGroupPageQueryDto(), { status: 'all' }))).items[0]
    expect(await read()).toMatchObject({ activeMembers: 1, activeKeys: 2, _count: { members: 3, models: 0 }, budget: { periodId: null } })
    await db.organization.update({ where: { id: actor.organizationId }, data: { enabled: false } })
    expect(await read()).toMatchObject({ activeMembers: 0 })
    await db.organization.update({ where: { id: actor.organizationId }, data: { enabled: true } })
    await db.usageGroup.update({ where: { id: group.id }, data: { enabled: false } })
    expect(await read()).toMatchObject({ activeMembers: 0 })
    await db.usageGroup.update({ where: { id: group.id }, data: { enabled: true, archivedAt: now } })
    expect(await read()).toMatchObject({ activeMembers: 0 })
    expect(await db.groupBudgetPeriod.count({ where: { groupId: group.id } })).toBe(0)
  }))

  it('scopes all operations and prevents archived groups from being reactivated', async () => {
    await withTestDatabase(async db => {
      const a = await createOrganization(db); const b = await createOrganization(db)
      const service = new UsageGroupsService(db as PrismaService)
      const group = await service.create(a.actor, { name: 'Project A', type: 'PROJECT' })
      expect(group.defaultLimitCny.toString()).toBe('0')
      await expect(service.detail(b.actor.organizationId, group.id)).rejects.toMatchObject({ status: 404 })
      await expect(service.addMember(a.actor, group.id, b.account.id)).rejects.toMatchObject({ status: 403 })
      await service.addMember(a.actor, group.id, a.account.id)
      expect((await service.members(a.actor.organizationId, group.id)).items).toHaveLength(1)
      const models = [randomUUID(), randomUUID()]
      await db.publicModel.createMany({ data: models.map(id => ({ id, displayName: id })) })
      await service.replaceModels(a.actor, group.id, models)
      await expect(service.replaceModels(a.actor, group.id, ['missing-model'])).rejects.toMatchObject({ status: 400 })
      expect((await service.models(a.actor.organizationId, group.id)).map(item => item.publicModelId).sort()).toEqual(models.sort())
      await service.archive(a.actor, group.id)
      await expect(service.setEnabled(a.actor, group.id, true)).rejects.toMatchObject({ status: 409 })
      expect((await service.detail(a.actor.organizationId, group.id)).archivedAt).not.toBeNull()
    })
  })

  it('permanently revokes keys and device grants on removal, even after rejoining', async () => {
    await withTestDatabase(async db => {
      const { organization, account, actor } = await createOrganization(db)
      const service = new UsageGroupsService(db as PrismaService)
      const group = await service.create(actor, { name: 'Dept', type: 'DEPARTMENT' })
      await service.addMember(actor, group.id, account.id)
      const key = await db.employeeApiKey.create({ data: { organizationId: organization.id, groupId: group.id,
        accountId: account.id, createdById: account.id, name: 'Key', secretHash: randomUUID(), secretHint: 'test' } })
      const device = await db.device.create({ data: { organizationId: organization.id, accountId: account.id,
        name: 'device', refreshTokenHash: randomUUID() } })
      const grant = await db.deviceGrant.create({ data: { organizationId: organization.id, accountId: account.id,
        groupId: group.id, createdById: account.id, deviceId: device.id } })
      const link = await db.deviceGrantLink.create({ data: { deviceGrantId: grant.id, createdById: account.id,
        secretHash: randomUUID(), secretHint: 'link', secretEncrypted: { ciphertext: 'test' } } })
      await service.removeMember(actor, group.id, account.id)
      await service.addMember(actor, group.id, account.id)
      expect((await db.employeeApiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt).not.toBeNull()
      expect((await db.deviceGrant.findUniqueOrThrow({ where: { id: grant.id } })).deletedAt).not.toBeNull()
      expect((await db.device.findUniqueOrThrow({ where: { id: device.id } })).revokedAt).not.toBeNull()
      const revokedLink = await db.deviceGrantLink.findUniqueOrThrow({ where: { id: link.id } })
      expect(revokedLink.revokedAt).not.toBeNull()
      expect(revokedLink.secretEncrypted).toBeNull()
      expect(await db.auditLog.count({ where: { organizationId: organization.id, action: 'usage_group.remove_member' } })).toBe(1)
    })
  })

  it('removes region project memberships when a region member leaves', async () => {
    await withTestDatabase(async db => {
      const { organization, account, actor } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const region = await groups.create(actor, { name: '广东区域', type: 'REGION' })
      const ownerProject = await projects.create(actor, { regionId: region.id, code: 'GD-OWNER', name: '区域负责项目' })
      const viewerProject = await projects.create(actor, { regionId: region.id, code: 'GD-VIEWER', name: '区域只读项目' })
      await groups.addMember(actor, region.id, account.id)
      await projects.addMember(actor, ownerProject.id, { accountId: account.id, role: 'OWNER' })
      await projects.addMember(actor, viewerProject.id, { accountId: account.id, role: 'VIEWER' })
      const channel = await db.channel.create({ data: { name: '区域历史渠道', provider: 'test', protocol: 'OPENAI', baseUrl: 'http://upstream' } })
      const model = await db.publicModel.create({ data: { id: `model-${randomUUID()}`, displayName: '区域历史模型' } })
      const key = await db.employeeApiKey.create({ data: { organizationId: organization.id, groupId: region.id,
        accountId: account.id, createdById: account.id, name: '区域历史密钥', secretHash: randomUUID(), secretHint: 'test' } })
      const at = new Date()
      const usage = await db.usageLog.create({ data: {
        requestId: randomUUID(), organizationId: organization.id, accountId: account.id,
        groupId: region.id, budgetProjectId: ownerProject.id, credentialType: 'API_KEY', apiKeyId: key.id,
        publicModelId: model.id, upstreamModel: 'upstream', channelId: channel.id,
        protocol: 'OPENAI_CHAT', startedAt: at, finishedAt: at, durationMs: 12,
        statusCode: 200, costUsd: '1.25', usageSource: 'UPSTREAM', streaming: false,
        inputTokens: 10, outputTokens: 5
      } })

      await groups.removeMember(actor, region.id, account.id)

      const removedRegionMember = await db.groupMember.findUniqueOrThrow({ where: {
        groupId_accountId: { groupId: region.id, accountId: account.id } } })
      expect(removedRegionMember.removedAt).not.toBeNull()
      expect(await db.projectMember.count({ where: { organizationId: organization.id, accountId: account.id } })).toBe(0)
      expect((await projects.members(actor, ownerProject.id)).items).toEqual([])
      expect((await projects.members(actor, viewerProject.id)).items).toEqual([])
      const storedUsage = await db.usageLog.findUniqueOrThrow({ where: { id: usage.id } })
      expect(storedUsage).toMatchObject({ groupId: region.id, budgetProjectId: ownerProject.id, accountId: account.id })
      expect(storedUsage.costUsd.toFixed(8)).toBe('1.25000000')
    })
  })

  it('appoints and dismisses group leaders with scoping, idempotency and audit', async () => {
    await withTestDatabase(async db => {
      const a = await createOrganization(db)
      const service = new UsageGroupsService(db as PrismaService)
      const group = await service.create(a.actor, { name: 'Led', type: 'PROJECT' })
      const member = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: 'Member' } })
      const plain = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: 'Plain' } })
      for (const account of [member, plain]) {
        await db.membership.create({ data: { organizationId: a.actor.organizationId, accountId: account.id, role: 'MEMBER' } })
        await service.addMember(a.actor, group.id, account.id)
      }
      const memberRow = () => service.members(a.actor.organizationId, group.id).then(page => page.items.find(item => item.accountId === member.id)!)

      await expect(service.setLeader(a.actor, group.id, member.id, true)).resolves.toEqual({ accountId: member.id, role: 'LEADER' })
      await expect(service.setLeader(a.actor, group.id, member.id, true)).resolves.toEqual({ accountId: member.id, role: 'LEADER' })
      expect((await memberRow()).role).toBe('LEADER')
      await expect(service.setLeader(a.actor, group.id, member.id, false)).resolves.toEqual({ accountId: member.id, role: 'MEMBER' })
      expect((await memberRow()).role).toBe('MEMBER')

      const stranger = await createOrganization(db)
      await expect(service.setLeader(a.actor, group.id, stranger.account.id, true)).rejects.toMatchObject({ status: 404 })
      await expect(service.setLeader({ organizationId: a.actor.organizationId, sub: plain.id, role: 'MEMBER', tokenVersion: 1 }, group.id, member.id, true))
        .rejects.toMatchObject({ status: 403 })

      await service.removeMember(a.actor, group.id, member.id)
      await expect(service.setLeader(a.actor, group.id, member.id, true)).rejects.toMatchObject({ status: 404 })
      expect(await db.auditLog.count({ where: { organizationId: a.actor.organizationId, action: 'usage_group.set_leader', resourceId: group.id } })).toBeGreaterThanOrEqual(2)
    })
  })

  it('does not leave live credentials when removal races redemption and regeneration', async () => {
    vi.stubEnv('JWT_SECRET', 'local-integration-only')
    vi.stubEnv('MASTER_KEY', Buffer.alloc(32, 9).toString('base64'))
    vi.stubEnv('PUBLIC_URL', 'http://localhost:3000')
    await withTestDatabase(async db => {
      const { organization, account, actor } = await createOrganization(db)
      const service = new UsageGroupsService(db as PrismaService)
      const links = new DeviceGrantLinksService(db as PrismaService)
      const grants = new DeviceGrantsService(db as PrismaService, links)
      for (let attempt = 0; attempt < 3; attempt++) {
        const group = await service.create(actor, { name: 'Concurrent', type: 'PROJECT' })
        await service.addMember(actor, group.id, account.id)
        const grant = await db.deviceGrant.create({ data: { organizationId: organization.id, accountId: account.id,
          groupId: group.id, createdById: account.id } })
        const credential = createDeviceGrantLinkCredential(Buffer.alloc(32, 9))
        await links.createInTransaction(db, { organizationId: organization.id, actorId: account.id, grantId: grant.id,
          expiresAt: null, action: 'create', credential })
        const [removed] = await Promise.allSettled([
          service.removeMember(actor, group.id, account.id),
          grants.redeem({ link: credential.secret, device: { installationId: randomUUID(), name: 'Race', platform: 'windows', clientVersion: 'test' } }),
          links.regenerate(organization.id, account.id, grant.id, {})
        ])
        expect(removed.status).toBe('fulfilled')
        const stored = await db.deviceGrant.findUniqueOrThrow({ where: { id: grant.id }, include: { device: true, links: true } })
        expect(stored.deletedAt).not.toBeNull()
        if (stored.device) expect(stored.device.revokedAt).not.toBeNull()
        expect(stored.links.every(link => link.revokedAt && !link.secretEncrypted)).toBe(true)
        await service.addMember(actor, group.id, account.id)
        await expect(grants.redeem({ link: credential.secret, device: { installationId: randomUUID(), name: 'Retry', platform: 'windows', clientVersion: 'test' } })).rejects.toThrow()
      }
    })
  }, 30_000)
})
