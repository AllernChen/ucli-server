import { describe, expect, it, vi } from 'vitest'
import { createExclusiveAsyncRequestGate, createRequestLifecycle, deviceGrantQuery, grantActions, grantExpiryPayload, grantStatusLabel, linkExpiryPayload, linkStatusLabel, type DeviceGrantSummary, type DeviceGrantLinkStatus, type ManagedUser } from '../../apps/admin/src/device-grants.js'

type Expect<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type _ManagedUserHasLastSeenAt = Expect<Equal<'lastSeenAt' extends keyof ManagedUser ? true : false, true>>
type _DeviceGrantHasNoTopLevelLastSeenAt = Expect<Equal<'lastSeenAt' extends keyof DeviceGrantSummary ? true : false, false>>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

describe('device grant administration helpers', () => {
  it('calculates preset link expiry from the supplied time', () => {
    const now = new Date('2026-08-27T00:00:00.000Z')
    expect(linkExpiryPayload({ mode: '1d', customExpiresAt: '' }, now)).toEqual({ expiresAt: '2026-08-28T00:00:00.000Z' })
    expect(linkExpiryPayload({ mode: '7d', customExpiresAt: '' }, now)).toEqual({ expiresAt: '2026-09-03T00:00:00.000Z' })
    expect(linkExpiryPayload({ mode: '30d', customExpiresAt: '' }, now)).toEqual({ expiresAt: '2026-09-26T00:00:00.000Z' })
    expect(linkExpiryPayload({ mode: 'permanent', customExpiresAt: '' }, now)).toEqual({ expiresAt: null })
  })

  it('converts future custom link expiry to ISO and rejects invalid or past values', () => {
    const now = new Date('2026-08-27T00:00:00.000Z')
    expect(linkExpiryPayload({ mode: 'custom', customExpiresAt: '2026-08-28T00:00' }, now)).toEqual({ expiresAt: new Date('2026-08-28T00:00').toISOString() })
    expect(() => linkExpiryPayload({ mode: 'custom', customExpiresAt: '' }, now)).toThrow('请选择 URL 有效期')
    expect(() => linkExpiryPayload({ mode: 'custom', customExpiresAt: 'not-a-date' }, now)).toThrow('请选择有效的 URL 有效期')
    expect(() => linkExpiryPayload({ mode: 'custom', customExpiresAt: '2026-08-27T00:00' }, now)).toThrow('URL 有效期必须晚于当前时间')
  })

  it('labels each link status for the admin surface', () => {
    const cases: Array<[DeviceGrantLinkStatus, string]> = [
      ['AVAILABLE', '可用'], ['EXPIRED', '已过期'], ['REVOKED', '已撤销'], ['CONSUMED', '已使用']
    ]
    for (const [status, label] of cases) expect(linkStatusLabel(status)).toBe(label)
  })

  it('offers reversible actions for disabled grants and no actions for deleted grants', () => {
    expect(grantActions({ status: 'DISABLED' })).toEqual(['enable', 'edit-expiry', 'delete'])
    expect(grantActions({ status: 'DELETED' })).toEqual([])
  })

  it('maps the permanent option to a null expiry', () => {
    expect(grantExpiryPayload({ permanent: true, expiresAt: '2026-12-31T00:00' })).toEqual({ expiresAt: null })
  })

  it('converts a local expiry input to ISO and rejects an empty dated expiry', () => {
    expect(grantExpiryPayload({ permanent: false, expiresAt: '2026-12-31T00:00' }).expiresAt).toBe(new Date('2026-12-31T00:00').toISOString())
    expect(() => grantExpiryPayload({ permanent: false, expiresAt: '' })).toThrow('请选择有效期')
  })

  it('builds encoded grouped-list filters', () => {
    expect(deviceGrantQuery({ status: 'EXPIRED', q: '张 三', limit: 50, offset: 0 }))
      .toBe('status=EXPIRED&q=%E5%BC%A0+%E4%B8%89&limit=50&offset=0')
  })

  it('labels and exposes only valid actions for every derived grant status', () => {
    const cases = [
      ['AVAILABLE', '待绑定', ['disable', 'edit-expiry', 'delete']],
      ['BOUND', '已绑定', ['disable', 'edit-expiry', 'delete']],
      ['DISABLED', '已禁用', ['enable', 'edit-expiry', 'delete']],
      ['EXPIRED', '已过期', ['disable', 'edit-expiry', 'delete']],
      ['DELETED', '已删除', []]
    ] as const
    for (const [status, label, actions] of cases) {
      expect(grantStatusLabel(status)).toBe(label)
      expect(grantActions({ status })).toEqual(actions)
    }
  })

  it('rejects late user-detail GET and POST effects after a route change or unmount', async () => {
    const routeLifecycle = createRequestLifecycle()
    const loadLifecycle = createRequestLifecycle()
    const userOneRoute = routeLifecycle.next()
    const oldGet = deferred<void>()
    const latestGet = deferred<void>()
    const sameRoutePost = deferred<void>()
    const staleRoutePost = deferred<void>()
    const applied: string[] = []
    const oldLoad = loadLifecycle.next()
    const latestLoad = loadLifecycle.next()
    const completeGet = oldGet.promise.then(() => {
      if (routeLifecycle.isCurrent(userOneRoute) && loadLifecycle.isCurrent(oldLoad)) applied.push('old-user')
    })
    const completeLatestGet = latestGet.promise.then(() => {
      if (routeLifecycle.isCurrent(userOneRoute) && loadLifecycle.isCurrent(latestLoad)) applied.push('latest-user')
    })
    const completeSameRoutePost = sameRoutePost.promise.then(() => {
      if (routeLifecycle.isCurrent(userOneRoute)) applied.push('same-route-secret')
    })
    oldGet.resolve()
    latestGet.resolve()
    sameRoutePost.resolve()
    await Promise.all([completeGet, completeLatestGet, completeSameRoutePost])
    const completeStalePost = staleRoutePost.promise.then(() => {
      if (routeLifecycle.isCurrent(userOneRoute)) applied.push('old-route-secret')
    })
    const userTwoRoute = routeLifecycle.next()
    staleRoutePost.resolve()
    await completeStalePost
    if (routeLifecycle.isCurrent(userTwoRoute)) applied.push('new-route')
    routeLifecycle.dispose()
    if (routeLifecycle.isCurrent(userTwoRoute)) applied.push('after-unmount')

    expect(applied).toEqual(['latest-user', 'same-route-secret', 'new-route'])
  })

  it('runs one create request at a time and releases after success or failure', async () => {
    const pending = vi.fn()
    const gate = createExclusiveAsyncRequestGate(pending)
    const firstRequest = deferred<string>()
    const first = gate.run(() => firstRequest.promise)
    const blocked = await gate.run(async () => 'second')

    expect(blocked).toBeNull()
    expect(gate.pending).toBe(true)
    firstRequest.resolve('created')
    expect(await first).toBe('created')
    expect(gate.pending).toBe(false)
    await expect(gate.run(async () => { throw new Error('conflict') })).rejects.toThrow('conflict')
    expect(gate.pending).toBe(false)
    expect(await gate.run(async () => 'retry')).toBe('retry')
    expect(pending.mock.calls.map(([value]) => value)).toEqual([true, false, true, false, true, false])
  })
})
