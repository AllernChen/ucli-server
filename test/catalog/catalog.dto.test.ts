import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { validate } from 'class-validator'
import { ChannelProtocol } from '@prisma/client'
import {
  ChannelListQueryDto, CreateChannelDto, CreateModelPriceDto, CreatePublicModelDto,
  UpdateModelPriceDto, UpdatePublicModelDto
} from '../../apps/api/src/catalog.dto.js'

describe('channel catalog DTOs', () => {
  it('rejects an unknown channel lifecycle filter', async () => {
    const dto = Object.assign(new ChannelListQueryDto(), { limit: 50, offset: 0, lifecycle: 'DELETED' })

    const errors = await validate(dto)

    expect(errors.some(error => error.property === 'lifecycle')).toBe(true)
  })

  it.each([
    'ftp://api.example.com/models',
    'https://user:password@api.example.com/models'
  ])('rejects an unsafe model discovery URL: %s', async modelDiscoveryUrl => {
    const dto = Object.assign(new CreateChannelDto(), {
      name: 'Example', provider: 'example', protocol: ChannelProtocol.OPENAI,
      baseUrl: 'https://api.example.com', modelDiscoveryUrl
    })

    const errors = await validate(dto)

    expect(errors.some(error => error.property === 'modelDiscoveryUrl')).toBe(true)
  })
})

describe('public model DTOs', () => {
  it.each([
    { id: '', displayName: 'GPT-4o', manufacturer: 'OpenAI', contextSize: 128000, property: 'id' },
    { id: 'gpt-4o', displayName: '', manufacturer: 'OpenAI', contextSize: 128000, property: 'displayName' },
    { id: 'gpt-4o', displayName: 'GPT-4o', manufacturer: 'OpenAI', contextSize: 0, property: 'contextSize' },
    { id: 'gpt-4o', displayName: 'GPT-4o', manufacturer: 'OpenAI', contextSize: 1.5, property: 'contextSize' }
  ])('rejects an invalid public model create payload: $property', async input => {
    const dto = Object.assign(new CreatePublicModelDto(), input)

    const errors = await validate(dto)

    expect(errors.some(error => error.property === input.property)).toBe(true)
  })

  it('requires manufacturer when creating a public model', async () => {
    const dto = Object.assign(new CreatePublicModelDto(), {
      id: 'deepseek-v3', displayName: 'DeepSeek V3', contextSize: 128000
    })

    const errors = await validate(dto)

    expect(errors.some(error => error.property === 'manufacturer')).toBe(true)
  })

  it('accepts clearing the optional context size on update', async () => {
    const dto = Object.assign(new UpdatePublicModelDto(), { contextSize: null })

    await expect(validate(dto)).resolves.toHaveLength(0)
  })

  it.each([
    { inputPerMillion: '-1', outputPerMillion: '2', validFrom: '2026-08-21T00:00:00Z', property: 'inputPerMillion' },
    { inputPerMillion: '1', outputPerMillion: 'two', validFrom: '2026-08-21T00:00:00Z', property: 'outputPerMillion' },
    { inputPerMillion: '1', outputPerMillion: '2', validFrom: 'not-a-date', property: 'validFrom' },
    {
      inputPerMillion: '1', outputPerMillion: '2', validFrom: '2026-08-21T00:00:00Z',
      validUntil: '2026-08-20T00:00:00Z', property: 'validUntil'
    }
  ])('rejects an invalid model price create payload: $property', async input => {
    const dto = Object.assign(new CreateModelPriceDto(), input)

    const errors = await validate(dto)

    expect(errors.some(error => error.property === input.property)).toBe(true)
  })

  it('rejects an invalid ISO date on model price update', async () => {
    const dto = Object.assign(new UpdateModelPriceDto(), { validUntil: 'tomorrow' })

    const errors = await validate(dto)

    expect(errors.some(error => error.property === 'validUntil')).toBe(true)
  })

  it('defaults model procurement prices to CNY', () => {
    expect(new CreateModelPriceDto().currency).toBe('CNY')
  })
})
