import 'reflect-metadata'
import { validate } from 'class-validator'
import { describe, expect, it } from 'vitest'
import { BindChannelModelDto } from '../../apps/api/src/catalog.dto.js'

function dto(overrides: Record<string, unknown> = {}) {
  return Object.assign(new BindChannelModelDto(), {
    publicModelId: 'deepseek-v3', createPublicModel: false,
    upstreamModel: 'deepseek-chat', protocol: 'OPENAI_CHAT',
    ...overrides
  })
}

describe('channel model binding dto', () => {
  it('accepts exact matching mode without public model creation fields', async () => {
    await expect(validate(dto())).resolves.toHaveLength(0)
  })

  it('requires a display name and manufacturer in public model creation mode', async () => {
    const errors = await validate(dto({ createPublicModel: true }))
    expect(errors.map(error => error.property).sort()).toEqual(['manufacturer', 'publicModelDisplayName'])
  })

  it('accepts complete public model creation metadata', async () => {
    await expect(validate(dto({
      publicModelId: 'deepseek-r2', createPublicModel: true,
      publicModelDisplayName: 'DeepSeek R2', manufacturer: 'DeepSeek', contextSize: 160000
    }))).resolves.toHaveLength(0)
  })

  it('rejects invalid protocols and probe intervals', async () => {
    const errors = await validate(dto({ protocol: 'UNKNOWN', probeIntervalMinutes: 1 }))
    expect(errors.map(error => error.property).sort()).toEqual(['probeIntervalMinutes', 'protocol'])
  })
})
