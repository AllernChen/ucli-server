import 'reflect-metadata'
import { RequestMethod } from '@nestjs/common'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { validate } from 'class-validator'
import { describe, expect, it, vi } from 'vitest'
import { ROLES_KEY } from '../../packages/security/src/auth.js'
import {
  CostEvaluationDto, ProcurementCostQueryDto, ProcurementCostStatus
} from '../../apps/api/src/catalog.dto.js'
import { ProcurementCostsController } from '../../apps/api/src/procurement-costs.controller.js'

const channelModelId = '20000000-0000-4000-8000-000000000001'

describe('procurement cost controller', () => {
  it('exposes platform-admin workspace and evaluation routes', async () => {
    const service = { list: vi.fn(async () => ({ items: [] })), evaluate: vi.fn(async () => ({ totalCost: '0' })) }
    const controller = new ProcurementCostsController(service as any)
    const query = Object.assign(new ProcurementCostQueryDto(), { status: ProcurementCostStatus.NO_COST })
    const input = Object.assign(new CostEvaluationDto(), {
      at: '2026-08-24T10:00:00.000Z', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0
    })

    await expect(controller.list(query)).resolves.toEqual({ items: [] })
    await expect(controller.evaluate(channelModelId, input)).resolves.toEqual({ totalCost: '0' })
    expect(Reflect.getMetadata(PATH_METADATA, controller.list)).toBe('procurement-costs')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.list)).toBe(RequestMethod.GET)
    expect(Reflect.getMetadata(PATH_METADATA, controller.evaluate)).toBe('channel-models/:id/cost-evaluation')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.evaluate)).toBe(RequestMethod.POST)
    expect(Reflect.getMetadata(ROLES_KEY, ProcurementCostsController)).toEqual(['PLATFORM_ADMIN'])
  })

  it('rejects invalid filters, timestamps and token counts before service execution', async () => {
    const query = Object.assign(new ProcurementCostQueryDto(), {
      channelId: 'not-a-uuid', status: 'CONFLICTED', limit: 0, offset: -1
    })
    const input = Object.assign(new CostEvaluationDto(), {
      at: 'tomorrow', inputTokens: -1, outputTokens: 1.5, cachedTokens: 0, reasoningTokens: 0
    })

    const queryErrors = await validate(query)
    const inputErrors = await validate(input)
    expect(queryErrors.map(error => error.property)).toEqual(expect.arrayContaining(['channelId', 'status', 'limit', 'offset']))
    expect(inputErrors.map(error => error.property)).toEqual(expect.arrayContaining(['at', 'inputTokens', 'outputTokens']))
  })
})
