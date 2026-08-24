import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { UsageController } from '../../apps/api/src/usage.controller.js'

describe('usage controller', () => {
  it('includes the employee identity in usage log results', async () => {
    const findMany = vi.fn(async () => [{
      requestId: 'request-1',
      accountId: '10000000-0000-4000-8000-000000000001',
      account: { displayName: '陈旭均', email: '443803527@qq.com' },
      routes: []
    }])
    const controller = new UsageController({ usageLog: { findMany } } as any)
    const request = {
      principal: {
        role: 'PLATFORM_ADMIN',
        organizationId: '20000000-0000-4000-8000-000000000001',
        sub: '10000000-0000-4000-8000-000000000001'
      }
    }

    await expect(controller.logs(request, {})).resolves.toEqual([expect.objectContaining({
      account: { displayName: '陈旭均', email: '443803527@qq.com' }
    })])
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: {
        account: { select: { displayName: true, email: true } },
        routes: true
      }
    }))
  })
})
