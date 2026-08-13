import Decimal from 'decimal.js'

export class QuotaExceededError extends Error {
  readonly code = 'QUOTA_EXCEEDED'
}

interface Amount { tokens: number; costUsd: string }
interface Limits { tokenLimit: number; costLimitUsd: string }
interface Reservation extends Amount { id: number; settled: boolean }

export class QuotaLedger {
  private usedTokens = 0
  private reservedTokens = 0
  private usedCost = new Decimal(0)
  private reservedCost = new Decimal(0)
  private sequence = 0
  private pendingAlerts: number[] = []
  private emittedAlerts = new Set<number>()

  constructor(private readonly limits: Limits) {}

  reserve(amount: Amount): Reservation {
    const cost = new Decimal(amount.costUsd)
    if (this.usedTokens + this.reservedTokens + amount.tokens > this.limits.tokenLimit ||
      this.usedCost.plus(this.reservedCost).plus(cost).gt(this.limits.costLimitUsd)) {
      throw new QuotaExceededError('Quota hard limit exceeded')
    }
    this.reservedTokens += amount.tokens
    this.reservedCost = this.reservedCost.plus(cost)
    return { ...amount, id: ++this.sequence, settled: false }
  }

  settle(reservation: Reservation, actual: Amount): void {
    if (reservation.settled) throw new TypeError('Reservation is already settled')
    reservation.settled = true
    this.reservedTokens -= reservation.tokens
    this.reservedCost = this.reservedCost.minus(reservation.costUsd)
    this.usedTokens += actual.tokens
    this.usedCost = this.usedCost.plus(actual.costUsd)
    this.updateAlerts()
  }

  release(reservation: Reservation): void {
    if (reservation.settled) return
    reservation.settled = true
    this.reservedTokens -= reservation.tokens
    this.reservedCost = this.reservedCost.minus(reservation.costUsd)
  }

  private updateAlerts(): void {
    const tokenPercent = this.limits.tokenLimit ? this.usedTokens / this.limits.tokenLimit * 100 : 0
    const costPercent = new Decimal(this.limits.costLimitUsd).isZero()
      ? 0
      : this.usedCost.div(this.limits.costLimitUsd).mul(100).toNumber()
    const percent = Math.max(tokenPercent, costPercent)
    for (const threshold of [50, 80, 100]) {
      if (percent >= threshold && !this.emittedAlerts.has(threshold)) {
        this.emittedAlerts.add(threshold)
        this.pendingAlerts.push(threshold)
      }
    }
  }

  takeAlerts(): number[] {
    return this.pendingAlerts.splice(0)
  }

  snapshot() {
    return {
      usedTokens: this.usedTokens,
      reservedTokens: this.reservedTokens,
      usedCostUsd: this.usedCost.toFixed(2),
      reservedCostUsd: this.reservedCost.toFixed(2)
    }
  }
}
