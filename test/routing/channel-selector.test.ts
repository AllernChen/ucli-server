import { describe, expect, it } from 'vitest'
import { selectChannel, selectKey, selectKeyRoundRobin } from '../../packages/gateway-core/src/routing.js'

describe('channel routing', () => {
  it('only selects from the highest healthy priority', () => {
    const picked = selectChannel([
      { id: 'low', priority: 1, weight: 100, healthy: true },
      { id: 'high', priority: 5, weight: 1, healthy: true },
      { id: 'broken', priority: 9, weight: 100, healthy: false }
    ], () => 0)
    expect(picked?.id).toBe('high')
  })

  it('uses weight within the same priority', () => {
    const channels = [
      { id: 'a', priority: 2, weight: 1, healthy: true },
      { id: 'b', priority: 2, weight: 3, healthy: true }
    ]
    expect(selectChannel(channels, () => 0.1)?.id).toBe('a')
    expect(selectChannel(channels, () => 0.9)?.id).toBe('b')
  })

  it('skips disabled, unhealthy and exhausted keys', () => {
    const picked = selectKey([
      { id: 'disabled', enabled: false, healthy: true, remainingUsd: 20, weight: 10 },
      { id: 'empty', enabled: true, healthy: true, remainingUsd: 0, weight: 10 },
      { id: 'ready', enabled: true, healthy: true, remainingUsd: null, weight: 1 }
    ], () => 0)
    expect(picked?.id).toBe('ready')
  })

  it('uses key priority before weight', () => {
    const picked = selectKey([
      { id: 'heavy-low', enabled: true, healthy: true, remainingUsd: null, priority: 1, weight: 100 },
      { id: 'light-high', enabled: true, healthy: true, remainingUsd: null, priority: 5, weight: 1 }
    ], () => 0)
    expect(picked?.id).toBe('light-high')
  })

  it('round robins keys within the highest priority', () => {
    const keys = [
      { id: 'a', enabled: true, healthy: true, remainingUsd: null, priority: 3, weight: 1 },
      { id: 'b', enabled: true, healthy: true, remainingUsd: null, priority: 3, weight: 1 }
    ]
    expect(selectKeyRoundRobin(keys, 0)?.id).toBe('a')
    expect(selectKeyRoundRobin(keys, 1)?.id).toBe('b')
    expect(selectKeyRoundRobin(keys, 2)?.id).toBe('a')
  })

  it('skips expired and temporarily isolated keys', () => {
    const now = new Date('2026-08-13T00:00:00Z')
    const picked = selectKey([
      { id: 'expired', enabled: true, healthy: true, remainingUsd: null, weight: 10, expiresAt: new Date('2026-08-12T00:00:00Z') },
      { id: 'isolated', enabled: true, healthy: true, remainingUsd: null, weight: 10, isolatedUntil: new Date('2026-08-14T00:00:00Z') },
      { id: 'ready', enabled: true, healthy: true, remainingUsd: null, weight: 1 }
    ], () => 0, now)
    expect(picked?.id).toBe('ready')
  })
})
