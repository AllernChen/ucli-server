import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { firstValueFrom, of } from 'rxjs'
import { JsonSafeInterceptor } from '../../packages/http/src/json.interceptor.js'

describe('JsonSafeInterceptor', () => {
  it('maps bigint values to strings in the emitted response', async () => {
    const interceptor = new JsonSafeInterceptor()
    const result = await firstValueFrom(interceptor.intercept({} as any, { handle: () => of({ id: 1n, nested: [2n] }) } as any))
    expect(result).toEqual({ id: '1', nested: ['2'] })
  })
})
