import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { firstValueFrom, of, throwError } from 'rxjs'
import { AuditInterceptor } from '../../packages/http/src/audit.interceptor.js'

function makeContext(method: string, path: string) {
  return { switchToHttp: () => ({ getRequest: () => ({ method, path, params: { id: 'x' }, principal: { sub: 'a', organizationId: 'o' } }) }) } as any
}

describe('AuditInterceptor', () => {
  it('writes an audit log on success for mutating api calls', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'log-1' })
    const interceptor = new AuditInterceptor({ auditLog: { create } } as any)
    await firstValueFrom(interceptor.intercept(makeContext('POST', '/api/v1/admin/channels'), { handle: () => of({ ok: true }) } as any))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: expect.stringContaining('POST') }) }))
  })
  it('skips logging for non-mutating methods', async () => {
    const create = vi.fn()
    const interceptor = new AuditInterceptor({ auditLog: { create } } as any)
    await firstValueFrom(interceptor.intercept(makeContext('GET', '/api/v1/usage/logs'), { handle: () => of({}) } as any))
    expect(create).not.toHaveBeenCalled()
  })
  it('writes a failure audit log when the handler throws', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'log-2' })
    const interceptor = new AuditInterceptor({ auditLog: { create } } as any)
    await expect(firstValueFrom(interceptor.intercept(makeContext('DELETE', '/api/v1/admin/devices/x/revoke'), { handle: () => throwError(() => new Error('boom')) } as any))).rejects.toThrow('boom')
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ metadata: { outcome: 'failure' } }) }))
  })
})
