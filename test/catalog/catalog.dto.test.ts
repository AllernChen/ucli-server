import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { validate } from 'class-validator'
import { ChannelProtocol } from '@prisma/client'
import { CreateChannelDto } from '../../apps/api/src/catalog.dto.js'

describe('channel catalog DTOs', () => {
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
