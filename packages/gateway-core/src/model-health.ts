export type ProbeOutcome = { ok: true } | { ok: false; terminal: boolean; errorCode: string }

export interface ModelHealthTransition {
  health: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
  consecutiveFailures: number
  lastErrorCode: string | null
}

export function nextModelHealth(
  current: { consecutiveFailures: number }, outcome: ProbeOutcome
): ModelHealthTransition {
  if (outcome.ok) return { health: 'HEALTHY', consecutiveFailures: 0, lastErrorCode: null }
  const consecutiveFailures = Math.max(0, current.consecutiveFailures) + 1
  return {
    health: outcome.terminal || consecutiveFailures >= 3 ? 'UNHEALTHY' : 'DEGRADED',
    consecutiveFailures,
    lastErrorCode: outcome.errorCode
  }
}
