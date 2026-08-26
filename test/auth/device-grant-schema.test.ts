import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schema = readFileSync('prisma/schema.prisma', 'utf8')
const migration = readFileSync('prisma/migrations/202608260001_device_grants/migration.sql', 'utf8')

describe('device grant schema', () => {
  it('makes member passwords optional and stores one grant per device', () => {
    expect(schema).toContain('passwordHash String?')
    expect(schema).toContain('model DeviceGrant')
    expect(schema).toContain('deviceId')
    expect(schema).toContain('@unique')
  })

  it('retires old authorization tables and revokes legacy devices', () => {
    expect(migration).toContain('DROP TABLE "invitations"')
    expect(migration).toContain('DROP TABLE "device_authorizations"')
    expect(migration).toContain('UPDATE "devices" SET "revoked_at"')
  })
})
