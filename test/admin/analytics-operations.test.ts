// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { AnalyticsQueryDto } from '../../apps/api/src/analytics.dto.js'
import Analytics from '../../apps/admin/src/views/Analytics.vue'
import TrendChart from '../../apps/admin/src/components/TrendChart.vue'
import UsageFilters from '../../apps/admin/src/components/UsageFilters.vue'

const state = vi.hoisted(() => ({ api: vi.fn(), downloadCsv: vi.fn(), push: vi.fn(), replace: vi.fn(), route: { query: {} as Record<string, string> }, setOption: vi.fn(), dispose: vi.fn() }))
vi.mock('../../apps/admin/src/api.js', () => ({ api: state.api, downloadCsv: state.downloadCsv }))
vi.mock('vue-router', () => ({ useRoute: () => state.route, useRouter: () => ({ push: state.push, replace: state.replace }) }))
vi.mock('echarts/core', () => ({ use: vi.fn(), init: () => ({ setOption: state.setOption, resize: vi.fn(), dispose: state.dispose }) }))

const range = { start: '2026-09-14T16:00:00.000Z', end: '2026-09-15T16:00:00.000Z', timezone: 'Asia/Shanghai' }
const metric = { requests: 1, inputTokens: '100', outputTokens: '20', totalTokens: '120', costCny: '1.5', costUsd: '99',
  successRate: 0, requestSuccessRate: 1, requestStates: { SUCCESS: 1, FAILED: 0, CANCELLED: 0, INTERRUPTED: 0 },
  cachedTokens: '10', uncachedInputTokens: '90', reasoningTokens: '2', cacheHitRate: .5,
  cacheCoverage: { knownInputTokens: '20', totalInputTokens: '100', unknownCalls: 3 }, estimatedCostCny: '.3',
  unallocatedCostCny: '.2', unsettledRequests: 1, avgCostPerRequestCny: '1.5', activeAccounts: 1, failoverRate: 0,
  errorCounts: [{ errorCode: 'RECONCILIATION_REQUIRED', requests: 1 }] }
let wrapper: VueWrapper | undefined
function start(query: Record<string, string> = range) {
  state.route.query = query
  wrapper = mount(Analytics, { global: { stubs: { TrendChart: true } } })
  return wrapper
}
function button(text: string) { return wrapper!.findAll('button').find(item => item.text() === text)! }
function calls(endpoint: string) { return state.api.mock.calls.map(([path]) => path as string).filter(path => path.includes(endpoint)) }
function query(path: string) { return Object.fromEntries(new URL(path, 'http://local').searchParams) }
beforeEach(() => {
  vi.clearAllMocks()
  state.route = reactive({ query: {} })
  state.api.mockImplementation(async (path: string) => {
    if (path.includes('/auth/me')) return { role: 'PLATFORM_ADMIN' }
    if (path.includes('/overview')) return { ...metric }
    if (path.includes('/timeseries')) return [{ ...metric, bucket: range.start }]
    if (path.includes('/breakdown')) return { items: [{ ...metric, id: 'a', name: '渠道A', drillQuery: { channelId: 'a' } }], total: 51, limit: 50, offset: Number(query(path).offset || 0) }
    if (path.includes('/filter-options')) return { page: null }
    throw new Error(`Unexpected request ${path}`)
  })
  state.downloadCsv.mockResolvedValue(undefined)
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.useRealTimers() })

it('pages all matching rows, drills to logs, and exports the applied dimension beyond the current page', async () => {
  start(); await flushPromises()
  expect(wrapper!.text()).toContain('共 51 条')
  await button('下一页').trigger('click'); await flushPromises()
  expect(query(calls('/breakdown').at(-1)!)).toMatchObject({ offset: '50', limit: '50', sort: 'costCny' })
  await wrapper!.get('[aria-label="查看匹配日志"]').trigger('click')
  expect(state.push).toHaveBeenCalledWith({ path: '/usage', query: { ...range, channelId: 'a' } })
  wrapper!.findComponent(UsageFilters).vm.$emit('update:modelValue', { ...range, publicModelId: 'unapplied' })
  await wrapper!.get('[aria-label="导出统计"]').trigger('click'); await flushPromises()
  expect(state.downloadCsv).toHaveBeenCalledWith(expect.stringContaining('/analytics/export?'), 'ucli-analytics.csv')
  expect(query(state.downloadCsv.mock.calls[0][0])).toEqual({ ...range, dimension: 'channel', sort: 'costCny', order: 'desc' })
})

it('separates successful requests from pending accounting and shows cache coverage and four historical prices', async () => {
  const original = state.api.getMockImplementation()!
  state.api.mockImplementation(async (path: string) => path.includes('/breakdown') ? {
    items: [{ ...metric, id: 'a'.repeat(32), name: '夜间历史价', avgInputPerMillion: '999', avgOutputPerMillion: '999',
      price: { inputPerMillion: '1.1', cachedPerMillion: '2.2', outputPerMillion: '3.3', reasoningPerMillion: '4.4',
        timezone: 'Asia/Shanghai', daysOfWeek: [1, 2], startMinute: 1320, endMinute: 120,
        validFrom: '2026-08-01T00:00:00Z', validTo: '2026-10-01T00:00:00Z' }, drillQuery: { priceKey: 'a'.repeat(32) } }], total: 1, limit: 50, offset: 0
  } : original(path))
  start({ ...range, dimension: 'costRule', billingState: 'UNKNOWN' }); await flushPromises()
  expect(wrapper!.text()).toContain('请求成功率 100.0%')
  expect(wrapper!.text()).toContain('待核算请求1')
  expect(wrapper!.text()).toContain('估算成本¥.3')
  expect(wrapper!.text()).toContain('缓存命中率50.0%')
  expect(wrapper!.text()).toContain('覆盖 20 / 100 输入 Token')
  expect(wrapper!.text()).toContain('缓存覆盖不足')
  expect(wrapper!.text()).toContain('3 次调用未提供可靠缓存数据')
  expect(wrapper!.text()).toContain('待核对标记 RECONCILIATION_REQUIRED')
  expect(wrapper!.text()).not.toContain('失败 RECONCILIATION_REQUIRED')
  for (const price of ['1.1', '2.2', '3.3', '4.4']) expect(wrapper!.text()).toContain(`¥${price}`)
  expect(wrapper!.text()).not.toContain('999')
  expect(wrapper!.text()).toContain('22:00–次日 02:00')
  expect(wrapper!.text()).toContain('2026-08-01T00:00:00Z')
  await wrapper!.get('[aria-label="继续分析"]').trigger('click'); await flushPromises()
  expect(query(calls('/overview').at(-1)!)).toMatchObject({ ...range, billingState: 'UNKNOWN', priceKey: 'a'.repeat(32) })
})

it('visibly blocks logs-only incoming data filters until explicitly cleared, then emits only DTO-compatible queries', async () => {
  const logsOnly = { requestId: 'one-request', sessionId: '22222222-2222-4222-8222-222222222222', projectId: '33333333-3333-4333-8333-333333333333' }
  start({ ...range, ...logsOnly, groupScope: 'UNGROUPED', channelModelScope: 'UNASSOCIATED', optionDimension: 'channel', q: 'do-not-leak', offset: '50' })
  await flushPromises()
  expect(wrapper!.text()).toContain('仅支持使用日志，请先清除此条件再统计')
  for (const value of Object.values(logsOnly)) expect(wrapper!.text()).toContain(value)
  expect(wrapper!.findComponent(UsageFilters).exists()).toBe(false)
  expect(calls('/analytics/')).toEqual([])
  await wrapper!.get('[aria-label="清除日志专属条件"]').trigger('click'); await flushPromises()
  expect(wrapper!.findComponent(UsageFilters).exists()).toBe(true)
  await wrapper!.get('[aria-label="渠道筛选"]').trigger('focus'); await flushPromises()
  for (const path of calls('/analytics/')) {
    const values = query(path)
    expect(values).toMatchObject({ ...range, groupScope: 'UNGROUPED', channelModelScope: 'UNASSOCIATED' })
    for (const key of [...Object.keys(logsOnly), 'q']) expect(values).not.toHaveProperty(key)
    if (!path.includes('/filter-options')) expect(values).not.toHaveProperty('optionDimension')
    expect(await validate(plainToInstance(AnalyticsQueryDto, values), { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0)
  }
})

it('keeps an explicit over-90-day interval visible and waits for a deliberate shorter range', async () => {
  start({ ...range, start: '2026-01-01T00:00:00Z' }); await flushPromises()
  expect(wrapper!.text()).toContain('统计范围不能超过 90 天')
  expect(wrapper!.text()).toContain('2026-01-01T00:00:00Z')
  expect(calls('/analytics/')).toHaveLength(0)
  expect(wrapper!.get('[aria-label="导出统计"]').attributes('disabled')).toBeDefined()
  await button('近 30 天').trigger('click'); await flushPromises()
  const value = query(calls('/overview').at(-1)!)
  expect(new Date(value.end).getTime() - new Date(value.start).getTime()).toBe(30 * 86400000)
  expect(query(calls('/timeseries').at(-1)!)).toMatchObject({ interval: 'day', timezone: 'Asia/Shanghai' })
})

it('charts null operational rates as gaps, uses CNY, and labels Shanghai midnight independently of the browser timezone', async () => {
  wrapper = mount(TrendChart, { props: { metric: 'cost', timezone: 'Asia/Shanghai', data: [
    { bucket: range.start, requests: 0, costCny: '1.5', costUsd: '99', requestSuccessRate: null, successRate: .5 },
    { bucket: range.end, requests: 1, costCny: '2.5', costUsd: '99', requestSuccessRate: 1, successRate: 0 }
  ] } })
  const option = () => state.setOption.mock.calls.at(-1)![0]
  expect(option().series[0].data).toEqual([1.5, 2.5])
  expect(option().series[1].data).toEqual([null, 100])
  expect(option().xAxis.data).toEqual(['09/15 00:00', '09/16 00:00'])
  await wrapper.setProps({ timezone: 'UTC', data: [{ bucket: range.start, costUsd: '3', successRate: .75 }] })
  expect(option().xAxis.data).toEqual(['09/14 16:00'])
  expect(option().series[0].data).toEqual([3])
  expect(option().series[1].data).toEqual([75])
  wrapper.unmount(); wrapper = mount(TrendChart, { props: { metric: 'requests', data: [{ bucket: range.start, requests: 1 }] } })
  expect(option().xAxis.data).toEqual(['09/14 16:00'])
  expect(option().series[1].data).toEqual([null])
})

it.each([
  ['group', { groupId: '11111111-1111-4111-8111-111111111111' }, { groupScope: 'UNGROUPED' }],
  ['apiKey', { apiKeyId: '11111111-1111-4111-8111-111111111111' }, { keyScope: 'NO_KEY' }],
  ['channelModel', { channelModelId: '11111111-1111-4111-8111-111111111111' }, { channelModelScope: 'UNASSOCIATED' }],
  ['channel', { channelId: '11111111-1111-4111-8111-111111111111' }, { allocation: 'UNALLOCATED' }]
])('honors the server null-row drill query for %s in both navigation actions', async (dimension, previous, drillQuery) => {
  const original = state.api.getMockImplementation()!
  state.api.mockImplementation(async (path: string) => path.includes('/breakdown') ? { items: [{ ...metric, id: null, name: '历史值', drillQuery }], total: 1, offset: 0, limit: 50 } : original(path))
  start({ ...range, ...previous, dimension, sort: 'requests', offset: '50', optionDimension: 'channel', q: 'temporary' } as Record<string, string>)
  await flushPromises()
  await wrapper!.get('[aria-label="查看匹配日志"]').trigger('click')
  expect(state.push).toHaveBeenCalledWith({ path: '/usage', query: { ...range, ...drillQuery } })
  await wrapper!.get('[aria-label="继续分析"]').trigger('click'); await flushPromises()
  expect(query(calls('/overview').at(-1)!)).toEqual({ ...range, ...drillQuery })
  expect(query(calls('/breakdown').at(-1)!)).toMatchObject({ offset: '0' })
})

it('restores browser history, keeps a fixed group through drilldown, and resets paging when sorting or changing dimension', async () => {
  const groupId = '11111111-1111-4111-8111-111111111111', channelId = '22222222-2222-4222-8222-222222222222'
  const original = state.api.getMockImplementation()!
  state.api.mockImplementation(async (path: string) => path.includes('/breakdown') ? { items: [{ ...metric, id: channelId, name: '渠道', drillQuery: { channelId } }], total: 51, offset: Number(query(path).offset || 0), limit: 50 } : original(path))
  start({ ...range, groupId, channelModelScope: 'UNASSOCIATED', offset: '50' }); await flushPromises()
  await wrapper!.get('[aria-label="继续分析"]').trigger('click'); await flushPromises()
  expect(query(calls('/overview').at(-1)!)).toEqual({ ...range, groupId, channelModelScope: 'UNASSOCIATED', channelId })
  await button('下一页').trigger('click'); await flushPromises()
  await button('请求数').trigger('click'); await flushPromises()
  expect(query(calls('/breakdown').at(-1)!)).toMatchObject({ offset: '0', sort: 'requests', order: 'desc' })
  await button('下一页').trigger('click'); await flushPromises()
  await button('员工 Key').trigger('click'); await flushPromises()
  expect(query(calls('/breakdown').at(-1)!)).toMatchObject({ offset: '0', dimension: 'apiKey' })
  state.route.query = { ...range, groupId, billingState: 'UNKNOWN', dimension: 'group', offset: '50' }; await flushPromises()
  expect(query(calls('/overview').at(-1)!)).toEqual({ ...range, groupId, billingState: 'UNKNOWN' })
  expect(wrapper!.text()).not.toContain(`渠道：${channelId}`)
  expect(wrapper!.get('[aria-label="渠道筛选"]').element).toHaveProperty('value', '')
  expect(query(calls('/breakdown').at(-1)!)).toMatchObject({ offset: '50', dimension: 'group' })
})

it('discards stale responses and chart data during reload and reports zero totals without inventing a success rate', async () => {
  start(); await flushPromises()
  const oldRequests: Array<{ path: string; resolve: (value: unknown) => void }> = []
  const original = state.api.getMockImplementation()!
  state.api.mockImplementation((path: string) => path.includes('/analytics/') ? new Promise(resolve => { oldRequests.push({ path, resolve }) }) : original(path))
  state.route.query = { ...range, publicModelId: 'old-pending' }; await flushPromises()
  expect(wrapper!.findComponent(TrendChart).exists()).toBe(false)
  expect(wrapper!.text()).not.toContain('渠道A')
  state.api.mockImplementation(async (path: string) => path.includes('/overview') ? { ...metric, requests: 0, requestSuccessRate: null, errorCounts: [] }
    : path.includes('/timeseries') ? [] : path.includes('/breakdown') ? { items: [], total: 0, offset: 0, limit: 50 } : original(path))
  state.route.query = { ...range, publicModelId: 'empty' }; await flushPromises()
  for (const old of oldRequests) old.resolve(old.path.includes('/overview') ? { ...metric, requests: 999 } : old.path.includes('/timeseries') ? [{ ...metric, bucket: range.start }] : { items: [{ ...metric, id: 'stale', name: 'Stale row' }], total: 999, offset: 0, limit: 50 })
  await flushPromises()
  expect(wrapper!.text()).toContain('共 0 条')
  expect(wrapper!.text()).toContain('请求成功率 未提供')
  expect(wrapper!.text()).not.toContain('999')
  expect(button('下一页').attributes('disabled')).toBeDefined()
})

it('surfaces CSV limits and suppresses an old export error after filters change', async () => {
  start(); await flushPromises()
  state.downloadCsv.mockRejectedValueOnce(new Error('CSV export exceeds 5000 rows; narrow the filter range'))
  await wrapper!.get('[aria-label="导出统计"]').trigger('click'); await flushPromises()
  expect(wrapper!.text()).toContain('CSV export exceeds 5000 rows')
  let rejectOld!: (value: Error) => void
  state.downloadCsv.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject }))
  await wrapper!.get('[aria-label="导出统计"]').trigger('click')
  state.route.query = { ...range, publicModelId: 'new' }; await flushPromises()
  rejectOld(new Error('old export failed')); await flushPromises()
  expect(wrapper!.text()).not.toContain('old export failed')
})

it('sorts the displayed request success through the independently validated operational sort', async () => {
  start({ ...range, offset: '50' }); await flushPromises()
  await button('请求成功率').trigger('click'); await flushPromises()
  const values = query(calls('/breakdown').at(-1)!)
  expect(values).toMatchObject({ sort: 'requestSuccessRate', order: 'desc', offset: '0' })
  expect(await validate(plainToInstance(AnalyticsQueryDto, values), { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0)
  await button('请求成功率').trigger('click'); await flushPromises()
  expect(query(calls('/breakdown').at(-1)!)).toMatchObject({ sort: 'requestSuccessRate', order: 'asc' })
})

it('shows all-day historical rules and missing snapshots without substituting weighted or current prices', async () => {
  const original = state.api.getMockImplementation()!
  state.api.mockImplementation(async (path: string) => path.includes('/breakdown') ? {
    items: [
      { ...metric, id: 'all-day', name: '全天价', price: { inputPerMillion: '0', cachedPerMillion: '0', outputPerMillion: '0', reasoningPerMillion: '0', daysOfWeek: [1], startMinute: 0, endMinute: 0, timezone: 'UTC' }, drillQuery: {} },
      { ...metric, id: 'missing', name: '缺失快照', price: null, avgInputPerMillion: '999', avgOutputPerMillion: '999', drillQuery: {} }
    ], total: 2, limit: 50, offset: 0
  } : original(path))
  start({ ...range, dimension: 'costRule' }); await flushPromises()
  expect(wrapper!.text()).toContain('周 1 · 全天')
  expect(wrapper!.text()).toContain('历史价格信息不足')
  expect(wrapper!.text()).toContain('¥0')
  expect(wrapper!.text()).not.toContain('999')
})

it('waits for role verification and sends Shanghai date boundaries with a clean full default range', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T17:00:00Z'))
  const original = state.api.getMockImplementation()!
  let resolveAuth!: (value: unknown) => void
  state.api.mockImplementation((path: string) => path.includes('/auth/me') ? new Promise(resolve => { resolveAuth = resolve }) : original(path))
  start({})
  await button('近 7 天').trigger('click'); await flushPromises()
  expect(calls('/analytics/')).toHaveLength(0)
  resolveAuth({ role: 'MEMBER' }); await flushPromises()
  expect(query(calls('/overview').at(-1)!)).toEqual({ start: '2026-09-09T16:00:00.000Z', end: '2026-09-16T16:00:00.000Z', timezone: 'Asia/Shanghai' })
  expect(wrapper!.get('[aria-label="开始日期"]').element).toHaveProperty('value', '2026-09-10')
  expect(wrapper!.get('[aria-label="结束日期"]').element).toHaveProperty('value', '2026-09-16')
  expect(wrapper!.find('[aria-label="组织筛选"]').exists()).toBe(false)
  vi.useRealTimers()
})

it('does not translate identity values that happen to match status enum names', async () => {
  start({ ...range, requestId: 'UNKNOWN', publicModelId: 'SUCCESS', billingState: 'UNKNOWN' }); await flushPromises()
  expect(wrapper!.text()).toContain('请求 ID：UNKNOWN')
  expect(wrapper!.text()).toContain('模型：SUCCESS')
  expect(wrapper!.text()).toContain('计费状态：待核对')
})
