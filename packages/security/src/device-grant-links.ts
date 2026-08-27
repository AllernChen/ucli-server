import type { EncryptedSecret } from './envelope-crypto.js'
import { decryptSecret, encryptSecret } from './envelope-crypto.js'
import { createOpaqueToken, hashOpaqueToken, opaqueTokenHint } from './tokens.js'

export type DeviceGrantLinkStatus = 'CONSUMED' | 'REVOKED' | 'EXPIRED' | 'AVAILABLE'
export type DeviceGrantLinkFailure = 'link_consumed' | 'link_revoked' | 'link_expired'

export interface DeviceGrantLinkLifecycle {
  consumedAt: Date | null
  revokedAt: Date | null
  expiresAt: Date | null
}

export interface DeviceGrantLinkCredential {
  secret: string
  secretHash: string
  secretHint: string
  secretEncrypted: EncryptedSecret
}

export function deriveDeviceGrantLinkStatus(
  link: DeviceGrantLinkLifecycle,
  now = new Date()
): DeviceGrantLinkStatus {
  if (link.consumedAt) return 'CONSUMED'
  if (link.revokedAt) return 'REVOKED'
  if (link.expiresAt && link.expiresAt <= now) return 'EXPIRED'
  return 'AVAILABLE'
}

export function deviceGrantLinkFailure(
  link: DeviceGrantLinkLifecycle,
  now = new Date()
): DeviceGrantLinkFailure | null {
  const status = deriveDeviceGrantLinkStatus(link, now)
  return status === 'AVAILABLE' ? null : `link_${status.toLowerCase()}` as DeviceGrantLinkFailure
}

export function createDeviceGrantLinkCredential(masterKey: Buffer): DeviceGrantLinkCredential {
  const secret = createOpaqueToken()
  return {
    secret,
    secretHash: hashOpaqueToken(secret),
    secretHint: opaqueTokenHint(secret),
    secretEncrypted: encryptSecret(secret, masterKey)
  }
}

export function revealDeviceGrantLinkSecret(value: EncryptedSecret, masterKey: Buffer): string {
  return decryptSecret(value, masterKey)
}
