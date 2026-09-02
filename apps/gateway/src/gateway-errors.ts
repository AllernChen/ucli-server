import { ServiceUnavailableException } from '@nestjs/common'

export type GatewayUnavailableCode =
  | 'model_protocol_unavailable'
  | 'model_channel_unavailable'
  | 'upstream_unavailable'

const DETAILS: Record<GatewayUnavailableCode, { message: string; retryable: boolean }> = {
  model_protocol_unavailable: { message: 'The model does not support the requested protocol', retryable: false },
  model_channel_unavailable: { message: 'No model channel is currently available', retryable: true },
  upstream_unavailable: { message: 'No upstream channel succeeded', retryable: true }
}

export function gatewayUnavailable(code: GatewayUnavailableCode, requestId: string) {
  return new ServiceUnavailableException({ statusCode: 503, code, ...DETAILS[code], requestId })
}

export function logGatewayFailure(input: {
  requestId: string
  organizationId: string
  accountId: string
  deviceId: string
  publicModelId: string
  protocol: string
  code: GatewayUnavailableCode
  routeAttempts: number
}) {
  console.warn('gateway-route-failed', { event: 'gateway_route_failed', ...input, timestamp: new Date().toISOString() })
}
