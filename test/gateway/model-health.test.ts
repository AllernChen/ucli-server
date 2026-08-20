import { describe, expect, it } from 'vitest'
import { nextModelHealth } from '../../packages/gateway-core/src/model-health.js'

describe('channel model health transitions', () => {
  it('clears failures and marks a successful probe healthy', () => {
    expect(nextModelHealth({ consecutiveFailures: 2 }, { ok: true })).toEqual({
      health: 'HEALTHY', consecutiveFailures: 0, lastErrorCode: null
    })
  })

  it('degrades for two transient failures and becomes unhealthy on the third', () => {
    expect(nextModelHealth({ consecutiveFailures: 0 }, { ok: false, terminal: false, errorCode: 'UPSTREAM_503' })).toEqual({
      health: 'DEGRADED', consecutiveFailures: 1, lastErrorCode: 'UPSTREAM_503'
    })
    expect(nextModelHealth({ consecutiveFailures: 1 }, { ok: false, terminal: false, errorCode: 'TIMEOUT' }).health).toBe('DEGRADED')
    expect(nextModelHealth({ consecutiveFailures: 2 }, { ok: false, terminal: false, errorCode: 'TIMEOUT' }).health).toBe('UNHEALTHY')
  })

  it('marks authentication and missing-model failures unhealthy immediately', () => {
    expect(nextModelHealth({ consecutiveFailures: 0 }, { ok: false, terminal: true, errorCode: 'AUTHENTICATION_FAILED' })).toEqual({
      health: 'UNHEALTHY', consecutiveFailures: 1, lastErrorCode: 'AUTHENTICATION_FAILED'
    })
  })
})
