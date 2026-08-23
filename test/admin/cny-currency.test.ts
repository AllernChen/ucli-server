import { describe, expect, it } from 'vitest'
import { formatCny, PLATFORM_CURRENCY } from '../../apps/admin/src/currency.js'

describe('admin platform currency', () => {
  it('uses CNY as the only platform business currency', () => {
    expect(PLATFORM_CURRENCY).toBe('CNY')
  })

  it('formats exact procurement amounts with the RMB symbol without losing precision', () => {
    expect(formatCny('0.003625')).toBe('¥0.003625')
    expect(formatCny(6)).toBe('¥6')
    expect(formatCny(null)).toBe('—')
  })
})
