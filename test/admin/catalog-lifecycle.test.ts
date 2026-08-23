import { describe, expect, it } from 'vitest'
import {
  lifecycleActions,
  lifecycleQuery,
  priceLifecycleActions,
  withLifecycle
} from '../../apps/admin/src/catalog-lifecycle.js'

describe('admin catalog lifecycle', () => {
  it('builds an encoded lifecycle query', () => {
    expect(lifecycleQuery('ARCHIVED')).toBe('lifecycle=ARCHIVED')
  })

  it('offers edit and archive for active records and restore for archived records', () => {
    expect(lifecycleActions({ deletedAt: null })).toEqual(['edit', 'archive'])
    expect(lifecycleActions({ deletedAt: '2026-08-21T00:00:00Z' })).toEqual(['restore'])
  })

  it('adds the lifecycle filter to collection and detail requests', () => {
    expect(withLifecycle('/api/v1/admin/channels', 'ARCHIVED')).toBe('/api/v1/admin/channels?lifecycle=ARCHIVED')
    expect(withLifecycle('/api/v1/admin/channels/abc?limit=100', 'ALL')).toBe('/api/v1/admin/channels/abc?limit=100&lifecycle=ALL')
  })

  it('prevents editing used prices while keeping archive and restore available', () => {
    expect(priceLifecycleActions({ deletedAt: null, used: false })).toEqual(['edit', 'archive'])
    expect(priceLifecycleActions({ deletedAt: null, used: true })).toEqual(['archive'])
    expect(priceLifecycleActions({ deletedAt: '2026-08-21T00:00:00Z', used: true })).toEqual(['restore'])
  })
})
