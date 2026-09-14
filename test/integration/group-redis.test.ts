import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import Redis from 'ioredis'
import { RedisQuotaService } from '../../packages/quota/src/redis-quota.js'
import { GroupBudgetService } from '../../packages/quota/src/group-budget.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { WorkerService } from '../../apps/worker/src/worker.service.js'
import { createOrganization, withTestDatabase } from './database.js'

describe.skipIf(!process.env.TEST_REDIS_URL)('group Redis recovery (real Redis)', () => {
  it('reserves and settles exactly once after a lost reply, preserving other concurrent usage', async () => {
    const url = new URL(process.env.TEST_REDIS_URL!)
    if (!['127.0.0.1', 'localhost', 'redis'].includes(url.hostname)) throw new Error('Test Redis must be local')
    const previous = process.env.REDIS_URL; process.env.REDIS_URL = url.href
    const service = new RedisQuotaService(); const redis = new Redis(url.href)
    try {
      const id = randomUUID(); const now = new Date()
      const identity = { organizationId: id, accountId: id, model: 'test', now, requestId: id }
      const reservation = await service.reserve(identity, { tokens: 10, costMicroUsd: 1 }, { dailyTokens: 100n, concurrency: 2 })
      await service.reserve(identity, { tokens: 10, costMicroUsd: 1 }, { dailyTokens: 100n, concurrency: 2 })
      expect(await redis.get(reservation.keys.dailyTokens)).toBe('10')
      await Promise.all([service.settle(reservation, { tokens: 5, costMicroUsd: 2 }), service.settle(reservation, { tokens: 5, costMicroUsd: 2 })])
      expect(await redis.get(reservation.keys.dailyTokens)).toBe('5')
      expect(await redis.get(reservation.keys.dailyCost)).toBe('2')
      expect(await redis.get(reservation.keys.concurrency)).toBe('0')
      await expect(service.release(reservation)).rejects.toThrow()
      await expect(service.renew(reservation)).rejects.toThrow()
      const correctionId = randomUUID()
      await service.correctCost(reservation, 4, correctionId); await service.correctCost(reservation, 4, correctionId)
      expect(await redis.get(reservation.keys.dailyCost)).toBe('4')
      const next = await service.reserve({ ...identity, requestId: randomUUID() }, { tokens: 7, costMicroUsd: 1 }, {})
      await service.releaseConcurrency(next); await service.releaseConcurrency(next)
      expect(await redis.get(next.keys.dailyTokens)).toBe('12')
      expect(await redis.get(next.keys.concurrency)).toBe('0')
      await Promise.all([service.release(next), service.release(next)])
      expect(await redis.get(next.keys.dailyTokens)).toBe('5')
      const sharedRequest = { ...identity, requestId: randomUUID() }
      const a = await service.reserve({ ...sharedRequest, policyId: 'policy-a' }, { tokens: 1, costMicroUsd: 1 }, { dailyTokens: 100n })
      const b = await service.reserve({ ...sharedRequest, policyId: 'policy-b' }, { tokens: 1, costMicroUsd: 1 }, { dailyTokens: 200n })
      expect(a.markerKey).not.toBe(b.markerKey)
      await service.release(a); await service.release(b)
      expect(await redis.get(next.keys.dailyTokens)).toBe('5')
    } finally { await service.close(); await redis.quit(); if (previous === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previous }
  })

  it.skipIf(!process.env.TEST_DATABASE_URL)('recovers unsent orphan reservations and retries Redis after a committed PG settlement', () => withTestDatabase(async db => {
    const previous = process.env.REDIS_URL; process.env.REDIS_URL = process.env.TEST_REDIS_URL
    const quota = new RedisQuotaService(); const redis = new Redis(process.env.TEST_REDIS_URL!)
    try {
      const { actor, organization, account } = await createOrganization(db)
      const group = await db.usageGroup.create({ data: { organizationId: organization.id, name: 'Recovery', type: 'PROJECT', defaultLimitCny: '1' } })
      await db.groupMember.create({ data: { organizationId: organization.id, accountId: account.id, groupId: group.id } })
      const device = await db.device.create({ data: { organizationId: organization.id, accountId: account.id, name: 'Recovery', refreshTokenHash: randomUUID() } })
      const channel = await db.channel.create({ data: { name: randomUUID(), provider: 'test', protocol: 'OPENAI', baseUrl: 'https://example.invalid' } })
      const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Recovery' } })
      const budget = new GroupBudgetService(db as PrismaService)
      const requestId = randomUUID(); const startedAt = new Date()
      const reservation = await quota.reserve({ organizationId: organization.id, accountId: account.id, model: model.id, now: startedAt, requestId }, { tokens: 10, costMicroUsd: 100 }, {})
      const entry = await budget.reserve({ requestId, identity: { ...actor, groupId: group.id, credentialType: 'DEVICE', deviceId: device.id }, startedAt,
        estimateCny: '0.5', snapshot: { redis: JSON.parse(JSON.stringify([reservation])) } })
      await budget.settle(entry, { actualCny: '0.00005000', usage: { requestId, organizationId: organization.id, accountId: account.id, groupId: group.id,
        credentialType: 'DEVICE', deviceId: device.id, channelId: channel.id, publicModelId: model.id, upstreamModel: 'test', protocol: 'OPENAI_CHAT',
        startedAt, finishedAt: startedAt, durationMs: 1, inputTokens: 2, outputTokens: 3, costUsd: '0.00005000', usageSource: 'UPSTREAM', streaming: false, statusCode: 200 } })
      expect(await redis.get(reservation.keys.dailyTokens)).toBe('10') // Crash before Redis synchronization.
      const worker = new WorkerService(db as PrismaService, {} as any, budget, quota)
      await worker.recoverGroupBudgets(); await worker.recoverGroupBudgets()
      expect(await redis.get(reservation.keys.dailyTokens)).toBe('5')
      expect(await redis.get(reservation.keys.dailyCost)).toBe('50')
      expect((await db.groupBudgetEntry.findUniqueOrThrow({ where: { id: entry.id } })).snapshot).toMatchObject({ redisSynced: true })
      await budget.reconcile(actor, group.id, entry.id, { operationId: randomUUID(), actualCny: '0.00003000', reason: 'Corrected supplier charge', action: 'SETTLE' })
      await worker.recoverGroupBudgets(); await worker.recoverGroupBudgets()
      expect(await redis.get(reservation.keys.dailyCost)).toBe('30')

      const orphan = await quota.reserve({ organizationId: organization.id, accountId: account.id, model: model.id, now: startedAt, requestId: randomUUID() }, { tokens: 7, costMicroUsd: 10 }, {})
      const marker = JSON.parse((await redis.get(orphan.markerKey!))!); marker.recoverAfter = 0
      await redis.set(orphan.markerKey!, JSON.stringify(marker))
      const stored = await db.groupBudgetEntry.findUniqueOrThrow({ where: { id: entry.id } })
      await db.groupBudgetEntry.update({ where: { id: entry.id }, data: { snapshot: { ...stored.snapshot as any, redisSynced: false } } })
      const originalSync = budget.syncQuota.bind(budget)
      const failedSync = vi.spyOn(budget, 'syncQuota').mockImplementation(async (ref, service) => {
        if (ref.id === entry.id) throw new Error('One damaged Redis marker')
        await originalSync(ref, service)
      })
      for (let i = 0; i < 10; i++) await worker.recoverGroupBudgets()
      expect(await redis.get(orphan.keys.dailyTokens)).toBe('5')
      failedSync.mockRestore()
      await worker.recoverGroupBudgets()
    } finally { await quota.close(); await redis.quit(); if (previous === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previous }
  }))
})
