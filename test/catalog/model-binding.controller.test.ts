import { describe, expect, it, vi } from 'vitest'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common'
import { ChannelModelsController } from '../../apps/api/src/channel-models.controller.js'

const channelId = '10000000-0000-4000-8000-000000000001'
const channelModelId = '20000000-0000-4000-8000-000000000001'
const input = {
  publicModelId: 'deepseek-v3', createPublicModel: false, upstreamModel: 'deepseek-chat',
  protocol: 'OPENAI_CHAT', supportsStream: true, supportsTools: true,
  probeEnabled: true, probeIntervalMinutes: 15
}

function makeController() {
  const modelBinding = { bind: vi.fn(async () => ({ operation: 'bind' })), rebind: vi.fn(async () => ({ operation: 'rebind' })) }
  const controller = new ChannelModelsController({} as any, {} as any, modelBinding as any)
  return { controller: controller as any, modelBinding }
}

describe('model binding controller', () => {
  it('exposes and delegates the channel bind route', async () => {
    const { controller, modelBinding } = makeController()
    await expect(controller.bind(channelId, input)).resolves.toEqual({ operation: 'bind' })
    expect(modelBinding.bind).toHaveBeenCalledWith(channelId, input)
    expect(Reflect.getMetadata(PATH_METADATA, controller.bind)).toBe('channels/:channelId/models/bind')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.bind)).toBe(RequestMethod.POST)
  })

  it('exposes and delegates the channel model rebind route', async () => {
    const { controller, modelBinding } = makeController()
    await expect(controller.rebind(channelModelId, input)).resolves.toEqual({ operation: 'rebind' })
    expect(modelBinding.rebind).toHaveBeenCalledWith(channelModelId, input)
    expect(Reflect.getMetadata(PATH_METADATA, controller.rebind)).toBe('channel-models/:id/bind')
    expect(Reflect.getMetadata(METHOD_METADATA, controller.rebind)).toBe(RequestMethod.PATCH)
  })
})
