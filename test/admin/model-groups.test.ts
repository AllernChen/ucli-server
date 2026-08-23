import { describe, expect, it } from 'vitest'
import type { PublicModel } from '../../apps/admin/src/types/catalog.js'
import { groupModelsByManufacturer, sumCostDecimals } from '../../apps/admin/src/model-groups.js'

function model(input: {
  id: string
  manufacturer: string
  manufacturerKey: string
  displayName?: string
  requests?: number
  costUsd?: string
}): PublicModel {
  return {
    id: input.id,
    manufacturer: input.manufacturer,
    manufacturerKey: input.manufacturerKey,
    displayName: input.displayName ?? input.id,
    contextSize: null,
    enabled: true,
    deletedAt: null,
    abilities: [],
    prices: [],
    usage24h: { requests: input.requests ?? 0, tokens: 0, costUsd: input.costUsd ?? '0' }
  }
}

describe('public model manufacturer groups', () => {
  it('groups two DeepSeek models under one manufacturer and totals usage', () => {
    const groups = groupModelsByManufacturer([
      model({ id: 'deepseek-v3', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek', requests: 10, costUsd: '1.25' }),
      model({ id: 'deepseek-r1', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek', requests: 5, costUsd: '0.75' })
    ])

    expect(groups).toEqual([expect.objectContaining({
      key: 'deepseek', name: 'DeepSeek', modelCount: 2, requests24h: 15, costUsd24h: '2.00000000'
    })])
  })

  it('keeps manufacturer groups and their models in deterministic display order', () => {
    const groups = groupModelsByManufacturer([
      model({ id: 'deepseek-v3', displayName: 'V3', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek' }),
      model({ id: 'claude-sonnet', manufacturer: 'Anthropic', manufacturerKey: 'anthropic' }),
      model({ id: 'deepseek-r1', displayName: 'R1', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek' })
    ])

    expect(groups.map(group => group.key)).toEqual(['anthropic', 'deepseek'])
    expect(groups[1].models.map(item => item.id)).toEqual(['deepseek-r1', 'deepseek-v3'])
  })

  it('chooses the same manufacturer display name regardless of input order', () => {
    const variants = [
      model({ id: 'deepseek-v3', manufacturer: 'DeepSeek', manufacturerKey: 'deepseek' }),
      model({ id: 'deepseek-r1', manufacturer: 'DEEPSEEK', manufacturerKey: 'deepseek' })
    ]

    expect(groupModelsByManufacturer(variants)[0].name).toBe('DeepSeek')
    expect(groupModelsByManufacturer([...variants].reverse())[0].name).toBe('DeepSeek')
  })

  it.each(['', '-1', '1e3', 'NaN', '1.123456789'])('rejects invalid procurement cost %s', value => {
    expect(() => sumCostDecimals([value])).toThrow(`Invalid procurement cost: ${value}`)
  })

  it('adds procurement costs exactly at eight decimal places without floating point loss', () => {
    expect(sumCostDecimals(['9007199254740993.00000001', '0.00000009'])).toBe('9007199254740993.00000010')
  })
})
