import { formatCny } from './currency.js'
export interface UsageGroup {
  id: string; name: string; description?: string; type: 'PROJECT' | 'DEPARTMENT'; enabled: boolean; archivedAt: string | null
  budgetMode: 'TOTAL' | 'MONTHLY'; budgetTimezone: string; unlimited: boolean; defaultLimitCny: string
  _count?: { members: number; models: number }
  budget: GroupBudget; activeMembers: number; activeKeys: number
}
export interface GroupBudget {
  groupId: string; periodId: string | null; periodKey: string; budgetMode: 'TOTAL' | 'MONTHLY'; budgetTimezone: string
  unlimited: boolean; defaultUnlimited: boolean; defaultLimitCny: string; limitCny: string
  spentCny: string; reservedCny: string; uncertainCny: string; availableCny: string | null
}
export const budgetLabel = (budget: { unlimited: boolean; limitCny: string }) => budget.unlimited ? '不限额' : formatCny(budget.limitCny)
// getRandomValues also works on the existing internal HTTP deployment (randomUUID requires HTTPS).
export function operationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
