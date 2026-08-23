import { describe, expect, it } from 'vitest'
import { normalizeManufacturer } from '../../apps/api/src/model-manufacturer.js'

describe('public model manufacturer normalization', () => {
  it('normalizes manufacturer whitespace and grouping key', () => {
    expect(normalizeManufacturer('  DeepSeek  AI  ')).toEqual({
      manufacturer: 'DeepSeek AI',
      manufacturerKey: 'deepseek ai'
    })
  })

  it('rejects a manufacturer containing only whitespace', () => {
    expect(() => normalizeManufacturer('   ')).toThrow('Manufacturer is required')
  })
})
