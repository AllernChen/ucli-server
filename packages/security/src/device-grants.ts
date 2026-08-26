export type DeviceGrantStatus = 'DELETED' | 'DISABLED' | 'EXPIRED' | 'BOUND' | 'AVAILABLE'
export type DeviceGrantFailure = 'grant_deleted' | 'grant_disabled' | 'grant_expired'

export interface DeviceGrantLifecycle {
  deviceId: string | null
  disabledAt: Date | null
  deletedAt: Date | null
  expiresAt: Date | null
}

export function deriveDeviceGrantStatus(grant: DeviceGrantLifecycle, now = new Date()): DeviceGrantStatus {
  if (grant.deletedAt) return 'DELETED'
  if (grant.disabledAt) return 'DISABLED'
  if (grant.expiresAt && grant.expiresAt <= now) return 'EXPIRED'
  return grant.deviceId ? 'BOUND' : 'AVAILABLE'
}

export function deviceGrantFailure(grant: DeviceGrantLifecycle, now = new Date()): DeviceGrantFailure | null {
  const status = deriveDeviceGrantStatus(grant, now)
  if (status === 'DELETED') return 'grant_deleted'
  if (status === 'DISABLED') return 'grant_disabled'
  if (status === 'EXPIRED') return 'grant_expired'
  return null
}
