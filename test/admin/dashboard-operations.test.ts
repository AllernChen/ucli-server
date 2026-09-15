// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import Dashboard from '../../apps/admin/src/Dashboard.vue'

const mocks = vi.hoisted(() => ({ api: vi.fn(), publicApi: vi.fn() }))
vi.mock('../../apps/admin/src/api', () => mocks)
vi.mock('vue-router', () => ({ useRoute: () => ({ name: 'overview' }) }))
const overview = { requests: 12, requestSuccessRate: 0.75, successRate: 1, activeAccounts: 3, inputTokens: '100', outputTokens: '20', cachedTokens: '30',
  costCny: '1.20000000', estimatedCostCny: '0.20000000', unsettledRequests: 2, cacheHitRate: 0.3, cacheCoverage: { knownInputTokens: '100', totalInputTokens: '100', unknownCalls: 0 } }
const alerts = { timestamp: '2026-09-16T00:00:00Z', budgetOrganizationId: 'org', channels: { total: 6, items: [{ id: 'c', name: 'Risk channel', health: 'DEGRADED' }] },
  budgets: { total: 6, items: [{ id: 'g', name: 'Risk group', budget: { unlimited: false, limitCny: '1', spentCny: '1', reservedCny: '0', availableCny: '0', uncertainCny: '0' } }] },
  unsettled: { total: 6, items: [{ id: 'l', requestId: 'r', label: 'Employee', costCny: '0.1', startedAt: '2025-01-01T00:00:00Z' }], start: '2025-01-01T00:00:00Z', end: '2026-09-16T00:00:00Z' } }
const routerLink = { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path + \'?\' + new URLSearchParams(to.query)"><slot /></a>', setup: () => ({ URLSearchParams }) }
const mountDashboard = () => mount(Dashboard, { global: { stubs: { RouterLink: routerLink, TrendChart: { props: ['data', 'metric', 'timezone'], template: '<div class="chart">{{ metric }}</div>' } } } })
beforeEach(() => {
  mocks.api.mockImplementation(async url => {
    if (url.startsWith('/api/v1/analytics/timeseries')) return []
    if (url.startsWith('/api/v1/analytics/overview')) return overview
    if (url.startsWith('/api/v1/monitoring/overview')) return alerts
    if (url.startsWith('/api/v1/admin/channels')) return { total: 12, items: [{ id: 'c', name: 'Measured channel', enabled: true, health: 'HEALTHY', timeoutMs: 30000, usage24h: { requests: 9, p95LatencyMs: null } }] }
    throw new Error(`Unexpected URL ${url}`)
  })
  mocks.publicApi.mockRejectedValue(new Error('HTTP 503'))
})
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

it('keeps analytics and paged channel data visible when health checks fail without inventing latency or dependency faults', async () => {
  const wrapper = mountDashboard(); await flushPromises()
  expect(wrapper.text()).toContain('检查失败')
  expect(wrapper.text()).toContain('今日采购成本')
  expect(wrapper.text()).toContain('75.0%')
  expect(wrapper.text()).toContain('Measured channel')
  expect(wrapper.text()).toContain('共 12 个渠道')
  expect(wrapper.text()).toContain('近24小时最终渠道请求')
  expect(wrapper.text()).not.toContain('30000 ms')
  expect(wrapper.text()).not.toContain('PostgreSQL 故障')
  expect(wrapper.text()).toContain('平台范围')
  expect(wrapper.text()).toContain('当前组织')
  expect(mocks.publicApi.mock.calls.map(call => call[0])).toEqual(['/healthz', '/gateway/healthz'])
  expect(mocks.api.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  wrapper.unmount()
})

it('aborts health requests at ten seconds and clears pending health work on unmount', async () => {
  vi.useFakeTimers()
  mocks.publicApi.mockImplementation(() => new Promise(() => {}))
  const wrapper = mountDashboard(); await flushPromises()
  expect(wrapper.get('[data-health="apiHealth"]').text()).toContain('检查中')
  await vi.advanceTimersByTimeAsync(10_000); await flushPromises()
  expect(wrapper.get('[data-health="apiHealth"]').text()).toContain('请求超时（10 秒）')
  expect(mocks.publicApi.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true)
  await wrapper.get('[aria-label="重试 API 健康检查"]').trigger('click')
  const latest = mocks.publicApi.mock.calls.at(-1)![1].signal
  wrapper.unmount()
  expect(latest.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('shows JSON and HTTP failures independently and retains the health endpoint last-success timestamp', async () => {
  mocks.publicApi.mockResolvedValue({ status: 'ok', timestamp: '2020-01-02T03:04:05Z' })
  const wrapper = mountDashboard(); await flushPromises()
  expect(wrapper.get('[data-health="apiHealth"]').text()).toContain('2020/1/2 11:04:05')
  mocks.publicApi.mockImplementation(async path => { throw path === '/healthz' ? new SyntaxError('Unexpected token <') : new Error('HTTP 401') })
  await wrapper.get('[aria-label="重试 API 健康检查"]').trigger('click')
  await wrapper.get('[aria-label="重试 Gateway 健康检查"]').trigger('click'); await flushPromises()
  expect(wrapper.get('[data-health="apiHealth"]').text()).toContain('响应不是有效 JSON')
  expect(wrapper.get('[data-health="apiHealth"]').text()).toContain('上次成功（非当前成功）：2020/1/2 11:04:05')
  expect(wrapper.get('[data-health="gatewayHealth"]').text()).toContain('HTTP 401')
  expect(wrapper.get('[data-section="costs"]').text()).toContain('¥1.2')
  expect(mocks.api.mock.calls.filter(([url]) => url === '/api/v1/monitoring/overview')).toHaveLength(1)
  wrapper.unmount()
})

it('uses Shanghai half-open day/month/week ranges, rejects stale metrics, and leaves current alerts independent', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T16:30:00Z'))
  const wrapper = mountDashboard(); await flushPromises()
  const calls = mocks.api.mock.calls.map(([url]) => new URL(url, 'http://test'))
  const dates = calls.filter(url => url.pathname === '/api/v1/analytics/overview').map(url => Object.fromEntries(url.searchParams))
  expect(dates).toContainEqual({ start: '2026-09-15T16:00:00.000Z', end: '2026-09-16T16:00:00.000Z', timezone: 'Asia/Shanghai' })
  expect(dates).toContainEqual({ start: '2026-08-31T16:00:00.000Z', end: '2026-09-16T16:00:00.000Z', timezone: 'Asia/Shanghai' })
  expect(Object.fromEntries(calls.find(url => url.pathname.endsWith('/timeseries'))!.searchParams)).toEqual({ start: '2026-09-09T16:00:00.000Z', end: '2026-09-16T16:00:00.000Z', timezone: 'Asia/Shanghai', interval: 'day' })
  const pending: Array<(value: any) => void> = []
  mocks.api.mockImplementation(() => new Promise(resolve => pending.push(resolve)))
  const periodSection = wrapper.get('[data-section="metrics"]')
  await periodSection.findAll('button').find(b => b.text() === '本月')!.trigger('click')
  expect(periodSection.text()).not.toContain('75.0%')
  await periodSection.findAll('button').find(b => b.text() === '今日')!.trigger('click')
  pending[1]({ ...overview, requests: 22 }); await flushPromises()
  pending[0]({ ...overview, requests: 999, requestSuccessRate: 0.01 }); await flushPromises()
  expect(periodSection.text()).toContain('22')
  expect(periodSection.text()).not.toContain('999')
  expect(periodSection.text()).toContain('75.0%')
  expect(wrapper.get('[data-section="alerts"]').text()).toContain('Risk group')
  expect(mocks.api.mock.calls.filter(([url]) => url === '/api/v1/monitoring/overview')).toHaveLength(1)
  expect(wrapper.findAll('.chart').map(chart => chart.text())).toEqual(['cost'])
  await wrapper.findAll('button').find(b => b.text() === '请求趋势')!.trigger('click')
  expect(wrapper.findAll('.chart').map(chart => chart.text())).toEqual(['requests'])
  wrapper.unmount()
})

it('links each alert to exact filters and hides the UNKNOWN link when no requests remain', async () => {
  const wrapper = mountDashboard(); await flushPromises()
  const link = (text: string) => wrapper.findAll('a').find(a => a.text() === text)!
  expect(link('查看全部降级渠道').attributes('href')).toBe('/channels?enabled=true&health=DEGRADED')
  expect(link('查看全部不健康渠道').attributes('href')).toBe('/channels?enabled=true&health=UNHEALTHY')
  expect(link('查看全部预算提醒').attributes('href')).toBe('/usage-groups?budgetRisk=ATTENTION&status=active')
  const unknown = new URL(link('查看全部待核算请求').attributes('href')!, 'http://test')
  expect(Object.fromEntries(unknown.searchParams)).toEqual({ billingState: 'UNKNOWN', start: alerts.unsettled.start, end: alerts.unsettled.end, timezone: 'Asia/Shanghai' })
  expect(wrapper.get('[data-section="alerts"]').text()).toContain('平台范围（6）')
  mocks.api.mockResolvedValue({ ...alerts, unsettled: { total: 0, items: [], start: null, end: alerts.unsettled.end } })
  await wrapper.get('[aria-label="重试当前提醒"]').trigger('click'); await flushPromises()
  expect(wrapper.text()).not.toContain('查看全部待核算请求')
  wrapper.unmount()
})

it('retries a failed module without losing other modules or making background probes', async () => {
  vi.useFakeTimers()
  const original = mocks.api.getMockImplementation()!
  mocks.api.mockImplementation((url, init) => url.startsWith('/api/v1/admin/channels') ? Promise.reject(new Error('渠道读取失败')) : original(url, init))
  const wrapper = mountDashboard(); await flushPromises()
  expect(wrapper.get('[data-section="channels"]').text()).toContain('渠道读取失败')
  expect(wrapper.get('[data-section="costs"]').text()).toContain('¥1.2')
  const calls = mocks.api.mock.calls.length, healthCalls = mocks.publicApi.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.api.mock.calls).toHaveLength(calls)
  expect(mocks.publicApi.mock.calls).toHaveLength(healthCalls)
  mocks.api.mockImplementation(original)
  await wrapper.get('[aria-label="重试渠道"]').trigger('click'); await flushPromises()
  expect(wrapper.get('[data-section="channels"]').text()).toContain('Measured channel')
  expect(mocks.api.mock.calls).toHaveLength(calls + 1)
  wrapper.unmount()
})
