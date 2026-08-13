import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface EncryptedSecret {
  algorithm: 'aes-256-gcm'
  iv: string
  tag: string
  ciphertext: string
}

function assertKey(masterKey: Buffer): void {
  if (masterKey.length !== 32) throw new TypeError('Master key must be exactly 32 bytes')
}

export function encryptSecret(plaintext: string, masterKey: Buffer): EncryptedSecret {
  assertKey(masterKey)
  if (!plaintext) throw new TypeError('Secret cannot be empty')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

export function decryptSecret(value: EncryptedSecret, masterKey: Buffer): string {
  assertKey(masterKey)
  if (value.algorithm !== 'aes-256-gcm') throw new TypeError('Unsupported secret algorithm')
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(value.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8')
}

export function secretSuffix(plaintext: string): string {
  return plaintext.slice(-4)
}
