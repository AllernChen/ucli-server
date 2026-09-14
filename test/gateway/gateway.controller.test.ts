import { describe, expect, it, vi } from 'vitest'
import { GatewayController } from '../../apps/gateway/src/gateway.controller.js'

describe('gateway model catalog', () => {
  it('publishes UCLI capability extensions in the OpenAI list envelope', async () => {
    const gateway = { models: vi.fn().mockResolvedValue([{
      id: 'model-1', displayName: 'Model 1', contextSize: 128000, protocols: ['openai_responses']
    }]) }
    const controller = new GatewayController(gateway as any)

    await expect(controller.models({ principal: {
      sub: 'account-1', organizationId: 'org-1', deviceId: 'device-1', role: 'MEMBER', credentialType: 'DEVICE', groupId: null
    } })).resolves.toEqual({ object: 'list', data: [{
      id: 'model-1', object: 'model', owned_by: 'ucli', display_name: 'Model 1',
      context_size: 128000, protocols: ['openai_responses']
    }] })
  })
  it('serves an employee key through both directories and filters the Anthropic protocol', async () => {
    const gateway = { models: vi.fn(async (_identity, protocol) => protocol === 'anthropic_messages'
      ? [{ id: 'claude-test', displayName: 'Claude', protocols: ['anthropic_messages'] }]
      : [{ id: 'chat-test', displayName: 'Chat', protocols: ['openai_chat'] }]) }
    const controller = new GatewayController(gateway as any)
    const principal = { credentialType: 'API_KEY', apiKeyId: 'key-1', groupId: 'group-1', sub: 'employee', organizationId: 'org-1', role: 'MEMBER' }
    expect((await controller.models({ principal })).data[0].id).toBe('chat-test')
    expect(await controller.anthropicModels({ principal })).toMatchObject({ data: [{ id: 'claude-test', display_name: 'Claude' }] })
    expect(gateway.models).toHaveBeenLastCalledWith({ accountId: 'employee', organizationId: 'org-1', groupId: 'group-1', role: 'MEMBER' }, 'anthropic_messages')
  })
})
