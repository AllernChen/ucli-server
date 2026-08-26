import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common'
import { UsersController } from '../../apps/api/src/users.controller.js'

const accountId = '10000000-0000-4000-8000-000000000001'
const request = { principal: { organizationId: '20000000-0000-4000-8000-000000000001' } }
const input = { email: 'member@example.com', displayName: 'Member' }
const query = { limit: 50, offset: 0, q: 'member' }

function makeController() {
  const users = {
    create: vi.fn(async () => ({ id: accountId })), list: vi.fn(async () => ({ items: [] })),
    detail: vi.fn(async () => ({ id: accountId })), disable: vi.fn(async () => ({ status: 'DISABLED' })),
    enable: vi.fn(async () => ({ status: 'ACTIVE' }))
  }
  return { controller: new UsersController(users as any), users }
}

describe('managed users controller', () => {
  it('exposes and delegates the organization-scoped user collection routes', async () => {
    const { controller, users } = makeController()
    await expect(controller.create(request, input)).resolves.toEqual({ id: accountId })
    await expect(controller.list(request, query)).resolves.toEqual({ items: [] })
    expect(users.create).toHaveBeenCalledWith(request.principal.organizationId, input)
    expect(users.list).toHaveBeenCalledWith(request.principal.organizationId, query)
    expect(Reflect.getMetadata(PATH_METADATA, controller.create)).toBe('/')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.create)).toBe(RequestMethod.POST)
    expect(Reflect.getMetadata(PATH_METADATA, controller.list)).toBe('/')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.list)).toBe(RequestMethod.GET)
  })

  it('exposes and delegates user detail and lifecycle action routes', async () => {
    const { controller, users } = makeController()
    await expect(controller.detail(request, accountId)).resolves.toEqual({ id: accountId })
    await expect(controller.disable(request, accountId)).resolves.toEqual({ status: 'DISABLED' })
    await expect(controller.enable(request, accountId)).resolves.toEqual({ status: 'ACTIVE' })
    expect(users.detail).toHaveBeenCalledWith(request.principal.organizationId, accountId)
    expect(users.disable).toHaveBeenCalledWith(request.principal.organizationId, accountId)
    expect(users.enable).toHaveBeenCalledWith(request.principal.organizationId, accountId)
    expect(Reflect.getMetadata(PATH_METADATA, controller.detail)).toBe(':id')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.detail)).toBe(RequestMethod.GET)
    expect(Reflect.getMetadata(PATH_METADATA, controller.disable)).toBe(':id/disable')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.disable)).toBe(RequestMethod.POST)
    expect(Reflect.getMetadata(PATH_METADATA, controller.enable)).toBe(':id/enable')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.enable)).toBe(RequestMethod.POST)
  })
})
