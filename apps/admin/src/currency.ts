export const PLATFORM_CURRENCY = 'CNY' as const

export function formatCny(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  return `¥${value}`
}
