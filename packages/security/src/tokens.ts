import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function createDeviceCode(random: (size: number) => Buffer = randomBytes) {
  const bytes = random(32)
  let userCode = ''
  for (let index = 0; index < 8; index += 1) {
    userCode += USER_CODE_ALPHABET[bytes[index]! % USER_CODE_ALPHABET.length]
  }
  return {
    deviceCode: createHash('sha256').update(bytes).digest('base64url'),
    userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`
  }
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url')
}

export function verifyOpaqueToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(token))
  const expected = Buffer.from(expectedHash)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
