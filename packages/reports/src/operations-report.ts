export interface OperationsMetrics {
  title: string
  rangeLabel: string
  requests: number
  activeAccounts: number
  totalTokens: number
  costUsd: string
  successRate: number
  estimatedActiveMinutes: number
  peakHour: string
  topModel: string
}

export function renderOperationsReport(metrics: OperationsMetrics): string {
  return [
    `# ${metrics.title}`,
    '',
    `统计周期：${metrics.rangeLabel}`,
    '',
    '## 使用概览',
    '',
    `- 请求数：${metrics.requests}`,
    `- 活跃账号：${metrics.activeAccounts}`,
    `- Token 消耗：${metrics.totalTokens}`,
    `- 费用：¥${metrics.costUsd}`,
    `- 成功率：${(metrics.successRate * 100).toFixed(2)}%`,
    `- 估算活跃时长：${metrics.estimatedActiveMinutes} 分钟`,
    '',
    '## 使用分布',
    '',
    `- 高峰时段：${metrics.peakHour}`,
    `- 最常用模型：${metrics.topModel}`,
    '',
    '> 估算活跃时长由产生模型请求的不同 5 分钟时间桶计算，不代表实际工作时长。'
  ].join('\n')
}
