import { describe, expect, it } from 'vitest'
import { ChannelHealthWindow } from '../../packages/monitoring/src/health.js'

describe('passive channel health', () => {
  it('opens a circuit after consecutive failures and recovers after successes', () => {
    const health = new ChannelHealthWindow({ failureThreshold: 3, recoveryThreshold: 2, cooldownMs: 1000 })
    health.record(false, 100)
    health.record(false, 100)
    expect(health.record(false, 100).state).toBe('open')
    expect(health.canAttempt(500)).toBe(false)
    expect(health.canAttempt(1100)).toBe(true)
    expect(health.record(true, 1200).state).toBe('half_open')
    expect(health.record(true, 1300).state).toBe('closed')
  })
})
