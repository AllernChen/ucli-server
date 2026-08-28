import { describe, expect, it } from 'vitest'
import { configuredClientProtocols, upstreamProtocolsForClient } from '../../packages/gateway-core/src/model-capabilities.js'

function mapping(protocol: 'OPENAI_RESPONSES' | 'OPENAI_CHAT' | 'ANTHROPIC_MESSAGES' | 'GEMINI', overrides: any = {}) {
  const { channel: channelOverrides = {}, ...mappingOverrides } = overrides
  return {
    protocol, enabled: true, deletedAt: null,
    ...mappingOverrides,
    channel: { enabled: true, deletedAt: null, keys: [{ enabled: true, deletedAt: null }], ...channelOverrides }
  }
}

describe('model protocol capabilities', () => {
  it('projects upstream protocols to stable deduplicated client protocols', () => {
    expect(configuredClientProtocols([
      mapping('GEMINI'), mapping('OPENAI_CHAT'), mapping('ANTHROPIC_MESSAGES'), mapping('OPENAI_RESPONSES'), mapping('GEMINI')
    ])).toEqual(['openai_responses', 'openai_chat', 'anthropic_messages'])
  })

  it.each([
    ['disabled mapping', { enabled: false }],
    ['archived mapping', { deletedAt: new Date() }],
    ['disabled channel', { channel: { enabled: false } }],
    ['archived channel', { channel: { deletedAt: new Date() } }],
    ['channel without a key', { channel: { keys: [] } }],
    ['disabled key', { channel: { keys: [{ enabled: false, deletedAt: null }] } }],
    ['archived key', { channel: { keys: [{ enabled: true, deletedAt: new Date() }] } }]
  ])('excludes a %s', (_label, overrides) => {
    expect(configuredClientProtocols([mapping('OPENAI_RESPONSES', overrides)])).toEqual([])
  })

  it('does not treat health, isolation, or circuit state as static capability inputs', () => {
    expect(configuredClientProtocols([mapping('OPENAI_RESPONSES', {
      health: 'UNHEALTHY', channel: { health: 'UNHEALTHY', circuitOpenUntil: new Date(), keys: [
        { enabled: true, deletedAt: null, health: 'UNHEALTHY', isolatedUntil: new Date() }
      ] }
    })])).toEqual(['openai_responses'])
  })

  it('returns the exact upstream protocol set accepted by each client endpoint', () => {
    expect(upstreamProtocolsForClient('openai_responses')).toEqual(['OPENAI_RESPONSES'])
    expect(upstreamProtocolsForClient('openai_chat')).toEqual(['OPENAI_CHAT', 'GEMINI'])
    expect(upstreamProtocolsForClient('anthropic_messages')).toEqual(['ANTHROPIC_MESSAGES'])
    expect(upstreamProtocolsForClient('gemini')).toEqual(['GEMINI'])
  })
})
