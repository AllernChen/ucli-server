import { HttpException, Injectable, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import { createHash } from 'node:crypto'

export interface QuotaIdentity { organizationId: string; accountId: string; model: string; now?: Date; requestId?: string; policyId?: string }

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
local marker = nil
if KEYS[8] then
  marker = cjson.decode(ARGV[10])
  local old = redis.call('GET', KEYS[8])
  if old then
    old = cjson.decode(old)
    if old.fingerprint ~= marker.fingerprint or old.state ~= 'RESERVED' then return {0, 'RESERVATION_CONFLICT'} end
    return {1, 'OK', ''}
  end
end
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
if marker then
  local generation_key = KEYS[7] .. ':generation'
  if redis.call('EXISTS', KEYS[7]) == 0 then redis.call('SET', generation_key, KEYS[8]) end
  marker.generation = redis.call('GET', generation_key) or ''
  redis.call('EXPIRE', generation_key, 600)
  redis.call('SET', KEYS[8], cjson.encode(marker))
end
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
local marker = nil
if KEYS[6] then
  local raw = redis.call('GET', KEYS[6])
  if not raw then return {0, 'RESERVATION_MISSING'} end
  marker = cjson.decode(raw)
  if marker.state == 'SETTLED' then
    if marker.actualTokens ~= ARGV[9] or marker.actualCost ~= ARGV[10] then return {0, 'RESERVATION_CONFLICT'} end
    return marker.result
  end
end
for i = 1, 4 do
  if not marker or redis.call('EXISTS', KEYS[i]) == 1 then redis.call('INCRBY', KEYS[i], tonumber(ARGV[i])) end
end
local current = tonumber(redis.call('GET', KEYS[5]) or '0')
if current > 0 and (not marker or (not marker.concurrencyReleased and marker.generation == (redis.call('GET', KEYS[5] .. ':generation') or ''))) then redis.call('DECR', KEYS[5]) end
local exceeded = 0
if tonumber(ARGV[5]) > 0 and tonumber(redis.call('GET', KEYS[1]) or '0') > tonumber(ARGV[5]) then exceeded = 1 end
if tonumber(ARGV[6]) > 0 and tonumber(redis.call('GET', KEYS[2]) or '0') > tonumber(ARGV[6]) then exceeded = 1 end
if tonumber(ARGV[7]) > 0 and tonumber(redis.call('GET', KEYS[3]) or '0') > tonumber(ARGV[7]) then exceeded = 1 end
if tonumber(ARGV[8]) > 0 and tonumber(redis.call('GET', KEYS[4]) or '0') > tonumber(ARGV[8]) then exceeded = 1 end
local result = {1, 'OK'}
if exceeded == 1 then result = {0, 'HARD_LIMIT_EXCEEDED'} end
if marker then
  marker.state = 'SETTLED'; marker.actualTokens = ARGV[9]; marker.actualCost = ARGV[10]; marker.result = result
  redis.call('SET', KEYS[6], cjson.encode(marker), 'EX', 5529600)
end
return result
`

@Injectable()
export class RedisQuotaService implements OnModuleDestroy {
  private readonly redis: Redis
  private recoveryCursor = '0'
  constructor() { this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 2 }) }

  async reserve(identity: QuotaIdentity, estimate: { tokens: number; costMicroUsd: number }, limits: {
    dailyTokens?: bigint | null; monthlyTokens?: bigint | null; dailyCostUsd?: string | null;
    monthlyCostUsd?: string | null; qps?: number | null; tpm?: bigint | null; concurrency?: number | null
  }) {
    const keys = quotaReservationKeys(identity)
    const micro = (value?: string | null) => value ? Math.round(Number(value) * 1_000_000) : 0
    const args = [estimate.tokens, estimate.costMicroUsd, Number(limits.dailyTokens || 0), Number(limits.monthlyTokens || 0),
      micro(limits.dailyCostUsd), micro(limits.monthlyCostUsd), limits.qps || 0, Number(limits.tpm || 0), limits.concurrency || 0]
    const markerKey = identity.requestId ? `quota-request:${identity.requestId}:${createHash('sha256').update(JSON.stringify({ keys, policyId: identity.policyId })).digest('hex')}` : undefined
    const limitsSnapshot = { dailyTokens: Number(limits.dailyTokens || 0), monthlyTokens: Number(limits.monthlyTokens || 0),
      dailyCostMicroUsd: micro(limits.dailyCostUsd), monthlyCostMicroUsd: micro(limits.monthlyCostUsd) }
    const snapshot = { keys, estimate, limits: limitsSnapshot, markerKey, requestId: identity.requestId }
    const fingerprint = createHash('sha256').update(JSON.stringify({ keys, args })).digest('hex')
    const marker = { state: 'RESERVED', fingerprint, snapshot, recoverAfter: Date.now() + 120_000 }
    const result = await this.redis.eval(reserveQuotaLua, markerKey ? 8 : 7, ...Object.values(keys), ...(markerKey ? [markerKey] : []),
      ...args, ...(markerKey ? [JSON.stringify(marker)] : [])) as [number, string, string]
    if (Number(result[0]) !== 1) throw new HttpException(result[1], 429)
    const thresholds = String(result[2] || '').split(',').filter(Boolean).map(Number)
    return { ...snapshot, thresholds }
  }

  async settle(reservation: any, actual: { tokens: number; costMicroUsd: number }) {
    const tokenDelta = actual.tokens - reservation.estimate.tokens
    const costDelta = actual.costMicroUsd - reservation.estimate.costMicroUsd
    const result = await this.redis.eval(settleQuotaLua, reservation.markerKey ? 6 : 5,
      reservation.keys.dailyTokens, reservation.keys.monthlyTokens, reservation.keys.dailyCost,
      reservation.keys.monthlyCost, reservation.keys.concurrency, ...(reservation.markerKey ? [reservation.markerKey] : []), tokenDelta, tokenDelta, costDelta, costDelta,
      reservation.limits?.dailyTokens || 0, reservation.limits?.monthlyTokens || 0,
      reservation.limits?.dailyCostMicroUsd || 0, reservation.limits?.monthlyCostMicroUsd || 0,
      ...(reservation.markerKey ? [actual.tokens, actual.costMicroUsd] : [])) as [number, string]
    if (result[1].startsWith('RESERVATION_')) throw new HttpException(result[1], 409)
    return { exceeded: Number(result[0]) !== 1, code: result[1] }
  }

  async release(reservation: any) { return this.settle(reservation, { tokens: 0, costMicroUsd: 0 }) }

  async releaseConcurrency(reservation: any) {
    if (!reservation.markerKey) return
    await this.redis.eval(`local raw = redis.call('GET', KEYS[1]); if not raw then return end
      local marker = cjson.decode(raw)
      if marker.state ~= 'RESERVED' or marker.concurrencyReleased then return end
      if marker.generation == (redis.call('GET', KEYS[2] .. ':generation') or '') and tonumber(redis.call('GET', KEYS[2]) or '0') > 0 then redis.call('DECR', KEYS[2]) end
      marker.concurrencyReleased = true; redis.call('SET', KEYS[1], cjson.encode(marker))`, 2, reservation.markerKey, reservation.keys.concurrency)
  }

  async renew(reservation: any) {
    if (!reservation.markerKey) return
    const renewed = await this.redis.eval(`local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end
      local marker = cjson.decode(raw); if marker.state ~= 'RESERVED' then return 0 end
      marker.recoverAfter = tonumber(ARGV[1]); redis.call('SET', KEYS[1], cjson.encode(marker))
      if marker.generation == (redis.call('GET', KEYS[2] .. ':generation') or '') then
        redis.call('EXPIRE', KEYS[2], 600); redis.call('EXPIRE', KEYS[2] .. ':generation', 600)
      end
      return 1`, 2, reservation.markerKey, reservation.keys.concurrency, Date.now() + 120_000)
    if (Number(renewed) !== 1) throw new HttpException('RESERVATION_INACTIVE', 409)
  }

  async correctCost(reservation: any, costMicroUsd: number, operationId: string, version = 1) {
    if (!reservation.markerKey || !Number.isSafeInteger(costMicroUsd) || costMicroUsd < 0) throw new HttpException('Invalid quota cost correction', 400)
    const result = await this.redis.eval(`local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end
      local marker = cjson.decode(raw); if marker.state ~= 'SETTLED' then return 0 end
      if tonumber(ARGV[3]) < (marker.correctionVersion or 0) then return 1 end
      marker.corrections = marker.corrections or {}
      if marker.corrections[ARGV[1]] then
        if marker.corrections[ARGV[1]] ~= ARGV[2] then return 0 end
        return 1
      end
      local delta = tonumber(ARGV[2]) - tonumber(marker.correctedCost or marker.actualCost)
      for i = 2, 3 do if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('INCRBY', KEYS[i], delta) end end
      marker.correctedCost = ARGV[2]; marker.corrections[ARGV[1]] = ARGV[2]; marker.correctionVersion = tonumber(ARGV[3])
      redis.call('SET', KEYS[1], cjson.encode(marker), 'KEEPTTL'); return 1`, 3,
      reservation.markerKey, reservation.keys.dailyCost, reservation.keys.monthlyCost, operationId, costMicroUsd, version)
    if (Number(result) !== 1) throw new HttpException('RESERVATION_CORRECTION_CONFLICT', 409)
  }

  async expiredReservations(now: Date): Promise<any[]> {
    // ponytail: bounded SCAN; use a sorted recovery index if marker volume makes scans too slow.
    const [cursor, keys] = await this.redis.scan(this.recoveryCursor, 'MATCH', 'quota-request:*', 'COUNT', 100)
    this.recoveryCursor = cursor
    if (!keys.length) return []
    const values = await this.redis.mget(...keys)
    return values.filter((value): value is string => value !== null).map(value => JSON.parse(value))
      .filter(marker => marker.state === 'RESERVED' && marker.recoverAfter <= now.getTime()).map(marker => marker.snapshot)
  }
  async close() { await this.redis.quit() }
  async onModuleDestroy() { await this.close() }
}
