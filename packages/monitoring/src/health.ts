type CircuitState = 'closed' | 'open' | 'half_open'

export class ChannelHealthWindow {
  private failures = 0
  private successes = 0
  private state: CircuitState = 'closed'
  private openedAt = 0

  constructor(private readonly options: {
    failureThreshold: number
    recoveryThreshold: number
    cooldownMs: number
  }) {}

  canAttempt(now = Date.now()): boolean {
    if (this.state !== 'open') return true
    if (now - this.openedAt < this.options.cooldownMs) return false
    this.state = 'half_open'
    return true
  }

  record(success: boolean, now = Date.now()) {
    if (success) {
      this.failures = 0
      this.successes += 1
      if (this.state === 'half_open' && this.successes >= this.options.recoveryThreshold) {
        this.state = 'closed'
        this.successes = 0
      }
    } else {
      this.successes = 0
      this.failures += 1
      if (this.failures >= this.options.failureThreshold) {
        this.state = 'open'
        this.openedAt = now
      }
    }
    return this.snapshot()
  }

  snapshot() { return { state: this.state, failures: this.failures, successes: this.successes } }
}
