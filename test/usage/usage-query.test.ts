import 'reflect-metadata'
import { BadRequestException, ValidationPipe } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { describe, expect, it } from 'vitest'
import { AnalyticsQueryDto, UsageQueryDto } from '../../apps/api/src/analytics.dto.js'
import { requestStateSql, resolveUsageFilter, usageWhere } from '../../apps/api/src/usage-query.js'
import { withTestDatabase } from '../integration/database.js'

const now = new Date('2026-09-15T16:00:00Z')
const platform = { sub: 'platform', organizationId: 'home', role: 'PLATFORM_ADMIN' as const }
const member = { sub: 'self', organizationId: 'own', role: 'MEMBER' as const }

describe('usage query', () => {
  it('accepts shared operation filters on analytics HTTP queries and rejects invalid values', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })
    const metadata = { type: 'query' as const, metatype: AnalyticsQueryDto }
    await expect(pipe.transform({ timezone: 'Asia/Shanghai', requestState: 'SUCCESS', billingState: 'UNKNOWN', groupScope: 'UNGROUPED', keyScope: 'NO_KEY', costRuleId: '123e4567-e89b-12d3-a456-426614174000', priceKey: '0123456789abcdef0123456789abcdef', allocation: 'UNALLOCATED' }, metadata))
      .resolves.toMatchObject({ timezone: 'Asia/Shanghai', requestState: 'SUCCESS', billingState: 'UNKNOWN', groupScope: 'UNGROUPED', keyScope: 'NO_KEY', allocation: 'UNALLOCATED' })
    await expect(pipe.transform({ requestState: 'PENDING' }, metadata)).rejects.toBeInstanceOf(BadRequestException)
  })

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
    expect(() => resolveUsageFilter(platform, { channelModelId: '123e4567-e89b-12d3-a456-426614174000', channelModelScope: 'UNASSOCIATED' }, now)).toThrow(BadRequestException)
    expect(resolveUsageFilter(platform, { model: 'legacy' }, now)).toMatchObject({ publicModelId: 'legacy' })
  })

  it('binds request-state filtering values', () => {
    const where = usageWhere({
      ...resolveUsageFilter(platform, { start: '2026-09-14', end: '2026-09-15' }, now),
      requestState: 'SUCCESS', publicModelId: "model' OR 1=1 --"
    })
    expect(where.strings.join('')).not.toContain("model' OR 1=1 --")
    expect(where.values).toContain("model' OR 1=1 --")
    expect(where.values).toContain('SUCCESS')
  })

  it.skipIf(!process.env.TEST_DATABASE_URL)('classifies request state independently from reconciliation accounting markers', () => withTestDatabase(async db => {
    const rows = await db.$queryRaw<Array<{ state: string }>>(Prisma.sql`
      SELECT ${requestStateSql} AS state
      FROM (VALUES
        (200, 'RECONCILIATION_REQUIRED', false, false),
        (503, 'RECONCILIATION_REQUIRED', false, false),
        (200, 'UPSTREAM_ERROR', false, false),
        (500, NULL, true, false),
        (500, NULL, false, true),
        (500, NULL, true, true)
      ) AS u(status_code, error_code, client_cancelled, stream_interrupted)`)
    expect(rows.map(row => row.state)).toEqual(['SUCCESS', 'FAILED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'CANCELLED'])
  }))
})
