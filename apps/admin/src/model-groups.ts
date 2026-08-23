import type { PublicModel } from './types/catalog.js'

const COST_SCALE = 8
const COST_DIVISOR = 10n ** BigInt(COST_SCALE)

export interface ManufacturerModelGroup {
  key: string
  name: string
  models: PublicModel[]
  modelCount: number
  publishedCount: number
  channelModelCount: number
  requests24h: number
  tokens24h: number
  costUsd24h: string
}

export function sumCostDecimals(values: string[]): string {
  const total = values.reduce((sum, value) => sum + procurementCostUnits(value), 0n)
  return `${total / COST_DIVISOR}.${(total % COST_DIVISOR).toString().padStart(COST_SCALE, '0')}`
}

function procurementCostUnits(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) throw new Error(`Invalid procurement cost: ${value}`)
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * COST_DIVISOR + BigInt(fraction.padEnd(COST_SCALE, '0') || '0')
}

export function groupModelsByManufacturer(models: PublicModel[]): ManufacturerModelGroup[] {
  const groups = new Map<string, PublicModel[]>()
  for (const model of models) {
    const items = groups.get(model.manufacturerKey) || []
    items.push(model)
    groups.set(model.manufacturerKey, items)
  }
  return [...groups].map(([key, items]) => ({
    key,
    name: items.map(item => item.manufacturer).sort(compareText)[0],
    models: [...items].sort((left, right) => compareText(left.displayName, right.displayName) || compareText(left.id, right.id)),
    modelCount: items.length,
    publishedCount: items.filter(item => item.enabled && !item.deletedAt).length,
    channelModelCount: items.reduce((sum, item) => sum + item.abilities.length, 0),
    requests24h: items.reduce((sum, item) => sum + item.usage24h.requests, 0),
    tokens24h: items.reduce((sum, item) => sum + item.usage24h.tokens, 0),
    costUsd24h: sumCostDecimals(items.map(item => item.usage24h.costUsd))
  })).sort((left, right) => compareText(left.name, right.name) || compareText(left.key, right.key))
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'zh-CN')
}
