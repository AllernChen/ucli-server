import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { NotFoundException } from '@nestjs/common'
import { UuidPipe } from '../../packages/http/src/uuid.pipe.js'

describe('UuidPipe', () => {
  const pipe = new UuidPipe()
  it('passes a valid UUID through', () => {
    const id = 'b06bd295-f711-4e93-b3ef-db7ab2d90445'
    expect(pipe.transform(id)).toBe(id)
  })
  it('throws NotFoundException for an invalid value', () => {
    expect(() => pipe.transform('not-a-uuid')).toThrow(NotFoundException)
  })
})
