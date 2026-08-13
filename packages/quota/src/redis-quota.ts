import { Injectable, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'

export interface QuotaIdentity { organizationId: string; accountId: string; model: string; now?: Date }

export function quotaReservationKeys(identity: QuotaIdentity) {
  const now = identity.now || new Date()
  const day = now.toISOString().slice(0, 10)
  const month = day.slice(0, 7)
  const prefix = `${identity.organizationId}:${identity.accountId}:${identity.model}`
  return {
    dailyTokens: `quota:${prefix}:${day}:tokens`, monthlyTokens: `quota:${prefix}:${month}:tokens`,
    dailyCost: `quota:${prefix}:${day}:cost-microusd`, monthlyCost: `quota:${prefix}:${month}:cost-microusd`,
    qps: `rate:${prefix}:${Math.floor(now.getTime() / 1000)}`,
    tpm: `rate:${prefix}:${Math.floor(now.getTime() / 60000)}:tokens`, concurrency: `concurrency:${prefix}`
  }
}

export const reserveQuotaLua = `
local daily_tokens = tonumber(redis.call('GET', KEYS[1]) or '0')
local monthly_tokens = tonumber(redis.call('GET', KEYS[2]) or '0')
local daily_cost = tonumber(redis.call('GET', KEYS[3]) or '0')
local monthly_cost = tonumber(redis.call('GET', KEYS[4]) or '0')
local qps = tonumber(redis.call('GET', KEYS[5]) or '0')
local tpm = tonumber(redis.call('GET', KEYS[6]) or '0')
local concurrent = tonumber(redis.call('GET', KEYS[7]) or '0')
local before_percent = 0
if tonumber(ARGV[3]) > 0 then before_percent = math.max(before_percent, daily_tokens * 100 / tonumber(ARGV[3])) end
if tonumber(ARGV[4]) > 0 then before_percent = math.max(before_percent, monthly_tokens * 100 / tonumber(ARGV[4])) end
if tonumber(ARGV[5]) > 0 then before_percent = math.max(before_percent, daily_cost * 100 / tonumber(ARGV[5])) end
if tonumber(ARGV[6]) > 0 then before_percent = math.max(before_percent, monthly_cost * 100 / tonumber(ARGV[6])) end
if tonumber(ARGV[7]) > 0 and qps + 1 > tonumber(ARGV[7]) then return {0, 'QPS_EXCEEDED'} end
if tonumber(ARGV[8]) > 0 and tpm + tonumber(ARGV[1]) > tonumber(ARGV[8]) then return {0, 'TPM_EXCEEDED'} end
if tonumber(ARGV[9]) > 0 and concurrent + 1 > tonumber(ARGV[9]) then return {0, 'CONCURRENCY_EXCEEDED'} end
if tonumber(ARGV[3]) > 0 and daily_tokens + tonumber(ARGV[1]) > tonumber(ARGV[3]) then return {0, 'DAILY_TOKEN_QUOTA'} end
if tonumber(ARGV[4]) > 0 and monthly_tokens + tonumber(ARGV[1]) > tonumber(ARGV[4]) then return {0, 'MONTHLY_TOKEN_QUOTA'} end
if tonumber(ARGV[5]) > 0 and daily_cost + tonumber(ARGV[2]) > tonumber(ARGV[5]) then return {0, 'DAILY_COST_QUOTA'} end
if tonumber(ARGV[6]) > 0 and monthly_cost + tonumber(ARGV[2]) > tonumber(ARGV[6]) then return {0, 'MONTHLY_COST_QUOTA'} end
redis.call('INCRBY', KEYS[1], ARGV[1]); redis.call('EXPIRE', KEYS[1], 172800)
redis.call('INCRBY', KEYS[2], ARGV[1]); redis.call('EXPIRE', KEYS[2], 2764800)
redis.call('INCRBY', KEYS[3], ARGV[2]); redis.call('EXPIRE', KEYS[3], 172800)
redis.call('INCRBY', KEYS[4], ARGV[2]); redis.call('EXPIRE', KEYS[4], 2764800)
redis.call('INCR', KEYS[5]); redis.call('EXPIRE', KEYS[5], 2)
redis.call('INCRBY', KEYS[6], ARGV[1]); redis.call('EXPIRE', KEYS[6], 120)
redis.call('INCR', KEYS[7]); redis.call('EXPIRE', KEYS[7], 600)
local after_percent = 0
if tonumber(ARGV[3]) > 0 then after_percent = math.max(after_percent, (daily_tokens + tonumber(ARGV[1])) * 100 / tonumber(ARGV[3])) end
if tonumber(ARGV[4]) > 0 then after_percent = math.max(after_percent, (monthly_tokens + tonumber(ARGV[1])) * 100 / tonumber(ARGV[4])) end
if tonumber(ARGV[5]) > 0 then after_percent = math.max(after_percent, (daily_cost + tonumber(ARGV[2])) * 100 / tonumber(ARGV[5])) end
if tonumber(ARGV[6]) > 0 then after_percent = math.max(after_percent, (monthly_cost + tonumber(ARGV[2])) * 100 / tonumber(ARGV[6])) end
local alerts = ''
for _, threshold in ipairs({50, 80, 100}) do
  if before_percent < threshold and after_percent >= threshold then
    if alerts ~= '' then alerts = alerts .. ',' end
    alerts = alerts .. tostring(threshold)
  end
end
return {1, 'OK', alerts}
`

export const settleQuotaLua = `
for i = 1, 4 do redis.call('INCRBY', KEYS[i], tonumber(ARGV[i])) end
local current = tonumber(redis.call('GET', KEYS[5]) or '0')
if current > 0 then redis.call('DECR', KEYS[5]) end
local exceeded = 0
if tonumber(ARGV[5]) > 0 and tonumber(redis.call('GET', KEYS[1]) or '0') > tonumber(ARGV[5]) then exceeded = 1 end
if tonumber(ARGV[6]) > 0 and tonumber(redis.call('GET', KEYS[2]) or '0') > tonumber(ARGV[6]) then exceeded = 1 end
if tonumber(ARGV[7]) > 0 and tonumber(redis.call('GET', KEYS[3]) or '0') > tonumber(ARGV[7]) then exceeded = 1 end
if tonumber(ARGV[8]) > 0 and tonumber(redis.call('GET', KEYS[4]) or '0') > tonumber(ARGV[8]) then exceeded = 1 end
if exceeded == 1 then return {0, 'HARD_LIMIT_EXCEEDED'} end
return {1, 'OK'}
`

@Injectable()
export class RedisQuotaService implements OnModuleDestroy {
  private readonly redis: Redis
  constructor() { this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 2 }) }

  async reserve(identity: QuotaIdentity, estimate: { tokens: number; costMicroUsd: number }, limits: {
    dailyTokens?: bigint | null; monthlyTokens?: bigint | null; dailyCostUsd?: string | null;
    monthlyCostUsd?: string | null; qps?: number | null; tpm?: bigint | null; concurrency?: number | null
  }) {
    const keys = quotaReservationKeys(identity)
    const micro = (value?: string | null) => value ? Math.round(Number(value) * 1_000_000) : 0
    const args = [estimate.tokens, estimate.costMicroUsd, Number(limits.dailyTokens || 0), Number(limits.monthlyTokens || 0),
      micro(limits.dailyCostUsd), micro(limits.monthlyCostUsd), limits.qps || 0, Number(limits.tpm || 0), limits.concurrency || 0]
    const result = await this.redis.eval(reserveQuotaLua, 7, ...Object.values(keys), ...args) as [number, string, string]
    if (Number(result[0]) !== 1) throw Object.assign(new Error(result[1]), { code: result[1], status: 429 })
    const thresholds = String(result[2] || '').split(',').filter(Boolean).map(Number)
    return { keys, estimate, thresholds, limits: {
      dailyTokens: Number(limits.dailyTokens || 0), monthlyTokens: Number(limits.monthlyTokens || 0),
      dailyCostMicroUsd: micro(limits.dailyCostUsd), monthlyCostMicroUsd: micro(limits.monthlyCostUsd)
    } }
  }

  async settle(reservation: any, actual: { tokens: number; costMicroUsd: number }) {
    const tokenDelta = actual.tokens - reservation.estimate.tokens
    const costDelta = actual.costMicroUsd - reservation.estimate.costMicroUsd
    const result = await this.redis.eval(settleQuotaLua, 5,
      reservation.keys.dailyTokens, reservation.keys.monthlyTokens, reservation.keys.dailyCost,
      reservation.keys.monthlyCost, reservation.keys.concurrency, tokenDelta, tokenDelta, costDelta, costDelta,
      reservation.limits?.dailyTokens || 0, reservation.limits?.monthlyTokens || 0,
      reservation.limits?.dailyCostMicroUsd || 0, reservation.limits?.monthlyCostMicroUsd || 0) as [number, string]
    return { exceeded: Number(result[0]) !== 1, code: result[1] }
  }

  async release(reservation: any) { return this.settle(reservation, { tokens: 0, costMicroUsd: 0 }) }
  async close() { await this.redis.quit() }
  async onModuleDestroy() { await this.close() }
}
