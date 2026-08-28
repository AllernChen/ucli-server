import type { GatewayProtocol } from './protocol.js'

export type UpstreamGatewayProtocol = 'OPENAI_RESPONSES' | 'OPENAI_CHAT' | 'ANTHROPIC_MESSAGES' | 'GEMINI'

export interface ModelProtocolMapping {
  protocol: UpstreamGatewayProtocol
  enabled: boolean
  deletedAt: Date | null
  channel: {
    enabled: boolean
    deletedAt: Date | null
    keys: Array<{ enabled: boolean; deletedAt: Date | null }>
  }
}

const CLIENT_PROTOCOL_ORDER: readonly GatewayProtocol[] = [
  'openai_responses', 'openai_chat', 'anthropic_messages'
]

const CLIENT_UPSTREAMS: Record<GatewayProtocol, readonly UpstreamGatewayProtocol[]> = {
  openai_responses: ['OPENAI_RESPONSES'],
  openai_chat: ['OPENAI_CHAT', 'GEMINI'],
  anthropic_messages: ['ANTHROPIC_MESSAGES'],
  gemini: ['GEMINI']
}

export function upstreamProtocolsForClient(protocol: GatewayProtocol): UpstreamGatewayProtocol[] {
  return [...CLIENT_UPSTREAMS[protocol]]
}

export function configuredClientProtocols(mappings: readonly ModelProtocolMapping[]): GatewayProtocol[] {
  const upstream = new Set(mappings.filter(item =>
    item.enabled && !item.deletedAt && item.channel.enabled && !item.channel.deletedAt &&
    item.channel.keys.some(key => key.enabled && !key.deletedAt)
  ).map(item => item.protocol))
  return CLIENT_PROTOCOL_ORDER.filter(protocol => CLIENT_UPSTREAMS[protocol].some(item => upstream.has(item)))
}
