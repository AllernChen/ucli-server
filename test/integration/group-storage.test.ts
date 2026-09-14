import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createOrganization, withTestDatabase } from './database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('group storage constraints (PostgreSQL)', () => {
  it('adds group storage without requiring groups for existing organizations', async () => {
    await withTestDatabase(async db => {
      const rows = await db.$queryRaw<Array<{ name: string | null }>>`SELECT to_regclass('usage_groups')::text AS name`
      expect(rows[0].name).toBe('usage_groups')
      const { organization } = await createOrganization(db)
      expect(organization.requireDeviceGroup).toBe(false)
    })
  })

  it('rejects cross-organization membership and keys and preserves precision', async () => {
    await withTestDatabase(async db => {
      const a = await createOrganization(db); const b = await createOrganization(db)
      const group = await db.usageGroup.create({ data: { organizationId: a.organization.id, name: 'A', type: 'PROJECT' } })
      await expect(db.groupMember.create({ data: {
        groupId: group.id, organizationId: b.organization.id, accountId: b.account.id
      } })).rejects.toMatchObject({ code: 'P2003' })
      await expect(db.employeeApiKey.create({ data: {
        groupId: group.id, organizationId: a.organization.id, accountId: b.account.id,
        name: 'Invalid', secretHash: randomUUID(), secretHint: 'test', createdById: a.account.id
      } })).rejects.toMatchObject({ code: 'P2003' })
      const period = await db.groupBudgetPeriod.create({ data: {
        organizationId: a.organization.id, groupId: group.id, periodKey: 'TOTAL', timezone: 'Asia/Shanghai', limitCny: '0.00000001'
      } })
      expect(period.limitCny.toFixed(8)).toBe('0.00000001')
      await expect(db.groupBudgetPeriod.update({ where: { id: period.id }, data: { reservedCny: '-1' } })).rejects.toThrow()
      await expect(db.usageGroup.delete({ where: { id: group.id } })).rejects.toMatchObject({ code: 'P2003' })
    })
  })

  it('allows only one request ledger entry per request and immutable key ownership', async () => {
    await withTestDatabase(async db => {
      const { organization, account } = await createOrganization(db)
      const group = await db.usageGroup.create({ data: { organizationId: organization.id, name: 'A', type: 'PROJECT' } })
      const other = await db.usageGroup.create({ data: { organizationId: organization.id, name: 'B', type: 'PROJECT' } })
      const key = await db.employeeApiKey.create({ data: {
        organizationId: organization.id, groupId: group.id, accountId: account.id, createdById: account.id,
        name: 'test', secretHash: randomUUID(), secretHint: 'test'
      } })
      await expect(db.employeeApiKey.update({ where: { id: key.id }, data: { groupId: other.id } })).rejects.toThrow()
      const period = await db.groupBudgetPeriod.create({ data: { organizationId: organization.id, groupId: group.id,
        periodKey: 'TOTAL', timezone: 'Asia/Shanghai', limitCny: '1' } })
      const data = { organizationId: organization.id, groupId: group.id, periodId: period.id, kind: 'REQUEST' as const,
        status: 'RESERVED' as const, requestId: randomUUID(), accountId: account.id, credentialType: 'API_KEY' as const,
        credentialId: key.id, reservedCny: '0.1', snapshot: {} }
      const results = await Promise.allSettled([1, 2].map(() => db.groupBudgetEntry.create({ data: { ...data, operationId: randomUUID() } })))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'P2002' } })
    })
  })

  it('keeps legacy device log attribution and rejects invalid credential shapes', async () => {
    await withTestDatabase(async db => {
      const { organization, account } = await createOrganization(db)
      const device = await db.device.create({ data: { organizationId: organization.id, accountId: account.id,
        name: 'Legacy device', refreshTokenHash: randomUUID() } })
      const channel = await db.channel.create({ data: { name: randomUUID(), provider: 'test', baseUrl: 'https://example.invalid', protocol: 'OPENAI' } })
      const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Test' } })
      const data = { organizationId: organization.id, accountId: account.id, deviceId: device.id, channelId: channel.id,
        publicModelId: model.id, upstreamModel: 'test', protocol: 'OPENAI_CHAT' as const, startedAt: new Date(), finishedAt: new Date(),
        durationMs: 1, usageSource: 'UPSTREAM' as const, streaming: false, statusCode: 200 }
      const log = await db.usageLog.create({ data: { ...data, requestId: randomUUID() } })
      expect(log).toMatchObject({ credentialType: 'DEVICE', groupId: null, apiKeyId: null, deviceId: device.id })
      await expect(db.device.delete({ where: { id: device.id } })).rejects.toMatchObject({ code: 'P2003' })
      await expect(db.usageLog.create({ data: { ...data, requestId: randomUUID(), deviceId: null } })).rejects.toThrow()
      await expect(db.usageLog.create({ data: { ...data, requestId: randomUUID(), credentialType: 'API_KEY' } })).rejects.toThrow()
      const group = await db.usageGroup.create({ data: { organizationId: organization.id, name: 'A', type: 'PROJECT' } })
      const key = await db.employeeApiKey.create({ data: { organizationId: organization.id, accountId: account.id,
        groupId: group.id, name: 'Key', createdById: account.id, secretHint: 'test', secretHash: randomUUID() } })
      const apiLog = await db.usageLog.create({ data: { ...data, requestId: randomUUID(), deviceId: null,
        credentialType: 'API_KEY', apiKeyId: key.id, groupId: group.id } })
      expect(apiLog.deviceId).toBeNull()
      const other = await createOrganization(db)
      await expect(db.usageLog.create({ data: { ...data, requestId: randomUUID(), deviceId: null,
        organizationId: other.organization.id, accountId: other.account.id,
        credentialType: 'API_KEY', apiKeyId: key.id, groupId: group.id } })).rejects.toMatchObject({ code: 'P2003' })
    })
  })
})
