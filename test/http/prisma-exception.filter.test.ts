import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { PrismaExceptionFilter } from '../../packages/http/src/prisma-exception.filter.js'

function makeHost(spy: ReturnType<typeof vi.fn>) {
  return { switchToHttp: () => ({ getResponse: () => ({ status: (code: number) => ({ json: (body: unknown) => spy(code, body) }) }) }) } as any
}
function prismaError(code: string) {
  return Object.assign(new Error(`error ${code}`), { code }) as Prisma.PrismaClientKnownRequestError
}

describe('PrismaExceptionFilter', () => {
  const filter = new PrismaExceptionFilter()
  it.each([
    ['P2025', 404], ['P2002', 409], ['P2003', 400], ['P2023', 400]
  ])('maps %s to HTTP %i', (code, status) => {
    const spy = vi.fn()
    filter.catch(prismaError(code), makeHost(spy))
    expect(spy).toHaveBeenCalledWith(status, expect.objectContaining({ statusCode: status }))
  })
  it('maps unknown codes to 500 and logs', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = vi.fn()
    filter.catch(prismaError('P9999'), makeHost(spy))
    expect(spy).toHaveBeenCalledWith(500, expect.objectContaining({ statusCode: 500 }))
    errorSpy.mockRestore()
  })
})
