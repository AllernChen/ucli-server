import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function createOpaqueToken(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString('base64url')
}

export function opaqueTokenHint(token: string): string {
  return `••••${token.slice(-6)}`
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url')
}

export function verifyOpaqueToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(token))
  const expected = Buffer.from(expectedHash)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
