import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common'
import { DeviceGrantsController } from '../../apps/api/src/device-grants.controller.js'
import { DeviceGrantFilter } from '../../apps/api/src/device-grants.dto.js'

const accountId = '10000000-0000-4000-8000-000000000001'
const grantId = '20000000-0000-4000-8000-000000000001'
const request = { principal: { organizationId: '30000000-0000-4000-8000-000000000001', sub: 'admin-1' } }
const createInput = { expiresAt: null }
const updateInput = { expiresAt: '2027-01-01T00:00:00.000Z' }
const query = { limit: 50, offset: 0, status: DeviceGrantFilter.ALL }

function makeController() {
  const grants = {
    create: vi.fn(async () => ({ id: grantId })), listGrouped: vi.fn(async () => ({ items: [] })),
    updateExpiration: vi.fn(async () => ({ id: grantId })), disable: vi.fn(async () => ({ id: grantId })),
    enable: vi.fn(async () => ({ id: grantId })), delete: vi.fn(async () => ({ id: grantId }))
  }
  return { controller: new DeviceGrantsController(grants as any), grants }
}

describe('device grants controller', () => {
  it('exposes and delegates the grant creation and grouped-listing routes in the current organization', async () => {
    const { controller, grants } = makeController()
    await controller.create(request, accountId, createInput)
    await controller.list(request, query)
    expect(grants.create).toHaveBeenCalledWith(request.principal.organizationId, request.principal.sub, accountId, createInput)
    expect(grants.listGrouped).toHaveBeenCalledWith(request.principal.organizationId, query)
    expect(Reflect.getMetadata(PATH_METADATA, controller.create)).toBe('users/:userId/device-grants')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.create)).toBe(RequestMethod.POST)
    expect(Reflect.getMetadata(PATH_METADATA, controller.list)).toBe('device-grants')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.list)).toBe(RequestMethod.GET)
  })

  it('exposes and delegates expiration and lifecycle routes in the current organization', async () => {
    const { controller, grants } = makeController()
    await controller.update(request, grantId, updateInput)
    await controller.disable(request, grantId)
    await controller.enable(request, grantId)
    await controller.delete(request, grantId)
    expect(grants.updateExpiration).toHaveBeenCalledWith(request.principal.organizationId, request.principal.sub, grantId, updateInput.expiresAt)
    expect(grants.disable).toHaveBeenCalledWith(request.principal.organizationId, request.principal.sub, grantId)
    expect(grants.enable).toHaveBeenCalledWith(request.principal.organizationId, request.principal.sub, grantId)
    expect(grants.delete).toHaveBeenCalledWith(request.principal.organizationId, request.principal.sub, grantId)
    expect(Reflect.getMetadata(PATH_METADATA, controller.update)).toBe('device-grants/:id')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.update)).toBe(RequestMethod.PATCH)
    expect(Reflect.getMetadata(PATH_METADATA, controller.disable)).toBe('device-grants/:id/disable')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.disable)).toBe(RequestMethod.POST)
    expect(Reflect.getMetadata(PATH_METADATA, controller.enable)).toBe('device-grants/:id/enable')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.enable)).toBe(RequestMethod.POST)
    expect(Reflect.getMetadata(PATH_METADATA, controller.delete)).toBe('device-grants/:id')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.delete)).toBe(RequestMethod.DELETE)
  })
})
