import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schema = readFileSync('prisma/schema.prisma', 'utf8')
const migration = readFileSync('prisma/migrations/202608270001_device_grant_links_expand/migration.sql', 'utf8')
const contractMigration = readdirSync('prisma/migrations')
  .find(name => name.endsWith('_device_grant_links_contract'))

describe('device grant link schema', () => {
  it('stores link credentials separately and relates links to grants and creators', () => {
    const account = schema.slice(schema.indexOf('model Account {'), schema.indexOf('model Membership {'))
    const grant = schema.slice(schema.indexOf('model DeviceGrant {'), schema.indexOf('model Channel {'))
    const deviceGrantLink = schema.slice(schema.indexOf('model DeviceGrantLink {'), schema.indexOf('model Channel {'))

    expect(grant).toMatch(/links\s+DeviceGrantLink\[\]/)
    expect(account).toMatch(/createdDeviceGrantLinks\s+DeviceGrantLink\[\]\s+@relation\("DeviceGrantLinkCreator"\)/)
    expect(deviceGrantLink).toMatch(/secretHash\s+String\s+@unique\s+@map\("secret_hash"\)/)
    expect(deviceGrantLink).toMatch(/secretEncrypted\s+Json\?\s+@map\("secret_encrypted"\)/)
    expect(deviceGrantLink).toContain('@@index([deviceGrantId, createdAt])')
  })

  it('backfills inert link history and enforces a single current link', () => {
    expect(migration).toContain('CREATE TABLE "device_grant_links"')
    expect(migration).toContain('"secret_encrypted" JSONB')
    expect(migration).toContain('INSERT INTO "device_grant_links"')
    expect(migration).toMatch(/CASE WHEN "device_id" IS NULL THEN CURRENT_TIMESTAMP ELSE NULL END/)
    expect(migration).toMatch(/CASE WHEN "device_id" IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END/)
    expect(migration).toMatch(/CREATE UNIQUE INDEX "device_grant_links_one_current_per_grant"[\s\S]*WHERE "revoked_at" IS NULL AND "consumed_at" IS NULL/)
  })

  it('removes legacy grant credentials only after every grant has link history', () => {
    const grant = schema.slice(schema.indexOf('model DeviceGrant {'), schema.indexOf('model Channel {'))
    expect(grant).not.toMatch(/tokenHash|tokenHint/)
    expect(contractMigration).toBeDefined()
    const sql = readFileSync(`prisma/migrations/${contractMigration}/migration.sql`, 'utf8')
    expect(sql).toMatch(/^BEGIN;/)
    expect(sql).toContain('device grant link backfill incomplete')
    expect(sql).toContain('ALTER TABLE "device_grants" DROP COLUMN "token_hash", DROP COLUMN "token_hint";')
    expect(sql).toMatch(/COMMIT;\s*$/)
  })
})
