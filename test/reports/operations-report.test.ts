import { describe, expect, it } from 'vitest'
import { renderOperationsReport } from '../../packages/reports/src/operations-report.js'

describe('operations report', () => {
  it('renders operational metrics without model request content', () => {
    const report = renderOperationsReport({
      title: '周报', rangeLabel: '2026-08-03 至 2026-08-10', requests: 20,
      activeAccounts: 3, totalTokens: 1000, costUsd: '1.20', successRate: 0.95,
      estimatedActiveMinutes: 40, peakHour: '14:00', topModel: 'gpt-5'
    })
    expect(report).toContain('估算活跃时长：40 分钟')
    expect(report).toContain('成功率：95.00%')
    expect(report).toContain('费用：¥1.20')
    expect(report).not.toContain('费用：$')
    expect(report).not.toContain('Prompt')
  })
})
