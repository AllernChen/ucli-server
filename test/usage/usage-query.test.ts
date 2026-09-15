import 'reflect-metadata'
import { BadRequestException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { describe, expect, it } from 'vitest'
import { UsageQueryDto } from '../../apps/api/src/analytics.dto.js'
import { requestStateSql, resolveUsageFilter, usageWhere } from '../../apps/api/src/usage-query.js'

const now = new Date('2026-09-15T16:00:00Z')
const platform = { sub: 'platform', organizationId: 'home', role: 'PLATFORM_ADMIN' as const }
const member = { sub: 'self', organizationId: 'own', role: 'MEMBER' as const }

describe('usage query', () => {
  it('rejects invalid scoped-operation query values at the HTTP DTO boundary', async () => {
    const dto = plainToInstance(UsageQueryDto, {
      timezone: 'Europe/London', requestState: 'PENDING', billingState: 'PENDING', groupScope: 'GROUPED', keyScope: 'KEYED',
      costRuleId: 'not-a-uuid', priceKey: 'ABCDEF', allocation: 'ALLOCATED'
    })
    const errors = await validate(dto)
    expect(errors.map(error => error.property).sort()).toEqual([
      'allocation', 'billingState', 'costRuleId', 'groupScope', 'keyScope', 'priceKey', 'requestState', 'timezone'
    ])
  })

  it('does not broaden member scope and separates time zone from timestamps', () => {
    const filter = resolveUsageFilter(member, {
      accountId: 'other', organizationId: 'else', timezone: 'Asia/Shanghai',
      start: '2026-09-14T16:00:00Z', end: '2026-09-15T16:00:00Z'
    })
    expect(filter).toMatchObject({ accountId: 'self', organizationId: 'own', timezone: 'Asia/Shanghai' })
    expect(filter.start.toISOString()).toBe('2026-09-14T16:00:00.000Z')
    expect(filter.end.toISOString()).toBe('2026-09-15T16:00:00.000Z')
  })

  it('defaults time zone and enforces analytics and hourly date windows', () => {
    expect(resolveUsageFilter(platform, {}, now)).toMatchObject({ timezone: 'UTC', start: new Date('2026-09-08T16:00:00Z'), end: now })
    expect(() => resolveUsageFilter(platform, { start: 'not-a-date', end: '2026-09-15' }, now)).toThrow(BadRequestException)
    expect(() => resolveUsageFilter(platform, { start: '2026-09-15', end: '2026-09-15' }, now)).toThrow(BadRequestException)
    expect(() => resolveUsageFilter(platform, { start: '2026-01-01', end: '2026-06-01' }, now)).toThrow(BadRequestException)
    expect(() => resolveUsageFilter(platform, { start: '2026-08-01', end: '2026-09-15', interval: 'hour' }, now)).toThrow(BadRequestException)
    expect(resolveUsageFilter(platform, { start: '2026-01-01', end: '2026-06-01' }, now, 'logs')).toMatchObject({ start: new Date('2026-01-01'), end: new Date('2026-06-01') })
  })

  it('rejects conflicting sentinels and different legacy model values', () => {
    expect(() => resolveUsageFilter(platform, { groupId: 'group', groupScope: 'UNGROUPED' }, now)).toThrow(BadRequestException)
    expect(() => resolveUsageFilter(platform, { apiKeyId: 'key', keyScope: 'NO_KEY' }, now)).toThrow(BadRequestException)
    expect(() => resolveUsageFilter(platform, { channelId: 'channel', allocation: 'UNALLOCATED' }, now)).toThrow(BadRequestException)
    expect(() => resolveUsageFilter(platform, { publicModelId: 'one', model: 'two' }, now)).toThrow(BadRequestException)
    expect(resolveUsageFilter(platform, { model: 'legacy' }, now)).toMatchObject({ publicModelId: 'legacy' })
  })

  it('binds request-state filtering while keeping accounting uncertainty out of request success', () => {
    const where = usageWhere({
      ...resolveUsageFilter(platform, { start: '2026-09-14', end: '2026-09-15' }, now),
      requestState: 'SUCCESS', publicModelId: "model' OR 1=1 --"
    })
    const state = requestStateSql.strings.join('')
    expect(where.strings.join('')).not.toContain("model' OR 1=1 --")
    expect(where.values).toContain("model' OR 1=1 --")
    expect(where.values).toContain('SUCCESS')
    expect(state).toContain("u.status_code NOT BETWEEN 200 AND 299 OR (u.error_code IS NOT NULL AND u.error_code <> 'RECONCILIATION_REQUIRED')")
    expect(state).toContain("WHEN u.client_cancelled THEN 'CANCELLED'")
    expect(state).toContain("WHEN u.stream_interrupted THEN 'INTERRUPTED'")
  })
})
