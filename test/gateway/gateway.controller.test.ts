import { describe, expect, it, vi } from 'vitest'
import { GatewayController } from '../../apps/gateway/src/gateway.controller.js'

describe('gateway model catalog', () => {
  it('publishes UCLI capability extensions in the OpenAI list envelope', async () => {
    const gateway = { models: vi.fn().mockResolvedValue([{
      id: 'model-1', displayName: 'Model 1', contextSize: 128000, protocols: ['openai_responses']
    }]) }
    const controller = new GatewayController(gateway as any)

    await expect(controller.models({ principal: {
      sub: 'account-1', organizationId: 'org-1', deviceId: 'device-1', role: 'MEMBER'
    } })).resolves.toEqual({ object: 'list', data: [{
      id: 'model-1', object: 'model', owned_by: 'ucli', display_name: 'Model 1',
      context_size: 128000, protocols: ['openai_responses']
    }] })
  })
})
