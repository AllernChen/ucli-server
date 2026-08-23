import type { CatalogLifecycle } from './types/catalog.js'

export type CatalogLifecycleAction = 'edit' | 'archive' | 'restore'

export function lifecycleQuery(value: CatalogLifecycle): string {
  return `lifecycle=${encodeURIComponent(value)}`
}

export function withLifecycle(path: string, value: CatalogLifecycle): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}${lifecycleQuery(value)}`
}

export function lifecycleActions(item: { deletedAt: string | null }): CatalogLifecycleAction[] {
  return item.deletedAt ? ['restore'] : ['edit', 'archive']
}

export function priceLifecycleActions(item: {
  deletedAt: string | null
  used: boolean
}): CatalogLifecycleAction[] {
  if (item.deletedAt) return ['restore']
  return item.used ? ['archive'] : ['edit', 'archive']
}
