import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schema = readFileSync('prisma/schema.prisma', 'utf8')
const migration = readFileSync('prisma/migrations/202608270001_device_grant_links_expand/migration.sql', 'utf8')
const contractMigration = readdirSync('prisma/migrations')
  .find(name => name.endsWith('_device_grant_links_contract'))
const issuanceMigration = readdirSync('prisma/migrations')
  .find(name => name.endsWith('_device_grant_link_issuance_order'))

function historicalBackfillOrder<T extends { id: string; deviceGrantId: string; createdAt: Date; revokedAt: Date | null; consumedAt: Date | null }>(links: T[]) {
  return [...links].sort((left, right) => {
    const leftCurrent = left.revokedAt === null && left.consumedAt === null
    const rightCurrent = right.revokedAt === null && right.consumedAt === null
    if (leftCurrent !== rightCurrent) return leftCurrent ? 1 : -1
    const leftEvidence = left.consumedAt ?? left.revokedAt ?? left.createdAt
    const rightEvidence = right.consumedAt ?? right.revokedAt ?? right.createdAt
    if (left.deviceGrantId !== right.deviceGrantId) return left.deviceGrantId.localeCompare(right.deviceGrantId)
    if (leftEvidence.getTime() !== rightEvidence.getTime()) return leftEvidence.getTime() - rightEvidence.getTime()
    if (left.createdAt.getTime() !== right.createdAt.getTime()) return left.createdAt.getTime() - right.createdAt.getTime()
    return left.id.localeCompare(right.id)
  })
}

describe('device grant link schema', () => {
  it('stores link credentials separately and relates links to grants and creators', () => {
    const account = schema.slice(schema.indexOf('model Account {'), schema.indexOf('model Membership {'))
    const grant = schema.slice(schema.indexOf('model DeviceGrant {'), schema.indexOf('model Channel {'))
    const deviceGrantLink = schema.slice(schema.indexOf('model DeviceGrantLink {'), schema.indexOf('model Channel {'))

    expect(grant).toMatch(/links\s+DeviceGrantLink\[\]/)
    expect(account).toMatch(/createdDeviceGrantLinks\s+DeviceGrantLink\[\]\s+@relation\("DeviceGrantLinkCreator"\)/)
    expect(deviceGrantLink).toMatch(/secretHash\s+String\s+@unique\s+@map\("secret_hash"\)/)
    expect(deviceGrantLink).toMatch(/secretEncrypted\s+Json\?\s+@map\("secret_encrypted"\)/)
    expect(deviceGrantLink).toMatch(/issuanceOrder\s+BigInt\s+@unique\s+@default\(autoincrement\(\)\)\s+@map\("issuance_order"\)/)
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
    expect(sql).not.toContain('issuance_order')
    expect(sql).toContain('device grant link backfill incomplete')
    expect(sql).toContain('ALTER TABLE "device_grants" DROP COLUMN "token_hash", DROP COLUMN "token_hint";')
    expect(sql).toMatch(/COMMIT;\s*$/)
  })

  it('upgrades a database that already applied the contract migration with an independent issuance-order migration', () => {
    expect(issuanceMigration).toBeDefined()
    if (!issuanceMigration) return
    const sql = readFileSync(`prisma/migrations/${issuanceMigration}/migration.sql`, 'utf8')
    expect(sql).toMatch(/^BEGIN;/)
    expect(sql).toContain('ALTER TABLE "device_grant_links" ADD COLUMN "issuance_order" BIGINT;')
    expect(sql).toContain('CREATE SEQUENCE "device_grant_links_issuance_order_seq"')
    expect(sql).toContain('ALTER TABLE "device_grant_links" ALTER COLUMN "issuance_order" SET DEFAULT nextval(')
    expect(sql).toContain('ALTER TABLE "device_grant_links" ALTER COLUMN "issuance_order" SET NOT NULL;')
    expect(sql).toContain('ALTER SEQUENCE "device_grant_links_issuance_order_seq" OWNED BY "device_grant_links"."issuance_order";')
    expect(sql).toContain('CREATE UNIQUE INDEX "device_grant_links_issuance_order_key"')
    expect(sql).toMatch(/COMMIT;\s*$/)
  })

  it('backfills multi-link history deterministically with lifecycle evidence before timestamps', () => {
    const links = [
      { id: 'revoked-later-created', deviceGrantId: 'grant-1', createdAt: new Date('2026-08-30T00:00:00Z'), revokedAt: new Date('2026-08-27T00:00:00Z'), consumedAt: null },
      { id: 'consumed', deviceGrantId: 'grant-1', createdAt: new Date('2026-08-26T00:00:00Z'), revokedAt: null, consumedAt: new Date('2026-08-28T00:00:00Z') },
      { id: 'current-earlier-created', deviceGrantId: 'grant-1', createdAt: new Date('2026-08-25T00:00:00Z'), revokedAt: null, consumedAt: null }
    ]
    const ordered = historicalBackfillOrder(links)

    expect(ordered.map(link => link.id)).toEqual(['revoked-later-created', 'consumed', 'current-earlier-created'])
    expect(ordered.at(-1)?.id).toBe('current-earlier-created')
    expect(issuanceMigration).toBeDefined()
    if (!issuanceMigration) return
    const sql = readFileSync(`prisma/migrations/${issuanceMigration}/migration.sql`, 'utf8')
    expect(sql).toContain('ROW_NUMBER() OVER')
    expect(sql).toContain('l."consumed_at"')
    expect(sql).toContain('l."revoked_at"')
    expect(sql).toContain('l."created_at"')
    expect(sql).toContain('l."id"')
  })
})
