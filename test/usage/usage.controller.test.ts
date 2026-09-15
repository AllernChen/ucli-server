import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { UsageController } from '../../apps/api/src/usage.controller.js'
import { AnalyticsController } from '../../apps/api/src/analytics.controller.js'
import { AnalyticsService } from '../../apps/api/src/analytics.service.js'
import { Prisma } from '@prisma/client'
import { GUARDS_METADATA, HEADERS_METADATA, PATH_METADATA } from '@nestjs/common/constants.js'
import { AuthGuard } from '../../packages/security/src/auth.js'

describe('usage controller', () => {
  it('keeps legacy logs as an array of safe historical identities', async () => {
    const findMany = vi.fn(async () => [{
      id: '30000000-0000-4000-8000-000000000001', requestId: 'request-1',
      accountId: '10000000-0000-4000-8000-000000000001',
      account: { displayName: 'Renamed', email: 'private@example.invalid' },
      actorSnapshot: { employeeName: '陈旭均', internalSecret: 'DO_NOT_EXPOSE' },
      costSnapshot: { internalSecret: 'DO_NOT_EXPOSE' }, costUsd: new Prisma.Decimal('1'), inputTokens: 1n, outputTokens: 0n, cachedTokens: 0n, reasoningTokens: 0n,
      routes: []
    }])
    const controller = new UsageController({ usageLog: { findMany }, $queryRaw: vi.fn(async () => [{
      id: '30000000-0000-4000-8000-000000000001', request_state: 'SUCCESS', matched_cost_cny: '1', price_keys: []
    }]) } as any)
    const request = {
      principal: {
        role: 'PLATFORM_ADMIN',
        organizationId: '20000000-0000-4000-8000-000000000001',
        sub: '10000000-0000-4000-8000-000000000001'
      }
    }

    const result = await controller.logs(request, {})
    expect(result).toEqual([expect.objectContaining({ employeeName: '陈旭均', costCny: '1.00000000', matchedCostCny: '1.00000000' })])
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EXPOSE|private@example.invalid|Renamed/)
    expect(result[0]).not.toHaveProperty('costSnapshot')
  })
  it('guards new routes and sets fixed CSV download headers', async () => {
    for (const controller of [UsageController, AnalyticsController]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toContain(AuthGuard)
      expect(Reflect.getMetadata(PATH_METADATA, controller.prototype.exportCsv)).toBe('export')
      expect(Reflect.getMetadata(HEADERS_METADATA, controller.prototype.exportCsv)).toEqual(expect.arrayContaining([
        { name: 'Content-Type', value: 'text/csv; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' },
        { name: 'Content-Disposition', value: expect.stringMatching(/^attachment; filename="[a-z-]+\.csv"$/) }
      ]))
    }
    expect(Reflect.getMetadata(PATH_METADATA, UsageController.prototype.options)).toBe('filter-options')
    expect(Reflect.getMetadata(PATH_METADATA, UsageController.prototype.detail)).toBe('logs/:id')
    const guard = new AuthGuard({} as any, {} as any)
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) } as any)).rejects.toMatchObject({ status: 401 })
  })
  it.each([5000, 5001])('exports up to 5000 rows and rejects %i rows instead of truncating either CSV', async count => {
    const request = { principal: { role: 'PLATFORM_ADMIN', organizationId: '20000000-0000-4000-8000-000000000001', sub: '10000000-0000-4000-8000-000000000001' } }
    const matches = Array.from({ length: count }, (_, i) => ({ id: String(i), request_state: 'SUCCESS', matched_cost_cny: '1', price_keys: [] }))
    const db = { $queryRaw: vi.fn(async () => matches), usageLog: { findMany: vi.fn(async () => matches.map(row => ({ ...row, accountId: 'account',
      costUsd: new Prisma.Decimal('1'), inputTokens: 1n, outputTokens: 0n, cachedTokens: 0n, reasoningTokens: 0n, routes: [] }))) } }
    const usage = new UsageController(db as any), analytics = new AnalyticsController(new AnalyticsService(db as any))
    for (const result of [usage.exportCsv(request, { limit: 1, offset: 999 }), analytics.exportCsv(request, { dimension: 'account', limit: 1, offset: 999 })]) {
      if (count === 5001) await expect(result).rejects.toMatchObject({ status: 400, message: expect.stringContaining('narrow') })
      else expect((await result).split('\r\n')).toHaveLength(5002)
    }
    expect(db.$queryRaw.mock.calls).toHaveLength(2)
    for (const [query] of db.$queryRaw.mock.calls as unknown as [Prisma.Sql][]) expect(query.values).toEqual(expect.arrayContaining([5001, 0]))
    if (count === 5001) expect(db.usageLog.findMany).not.toHaveBeenCalled()
  })
})
