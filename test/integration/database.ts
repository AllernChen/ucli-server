import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

export function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL
  if (!value) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests')
  const url = new URL(value)
  if (!['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(url.hostname) ||
      !/^\/ucli_test[a-z0-9_]*$/i.test(url.pathname)) {
    throw new Error('Integration tests require a local ucli_test database')
  }
  return value
}

export async function withTestDatabase(run: (db: PrismaClient) => Promise<void>) {
  const db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } })
  try { await run(db) } finally { await db.$disconnect() }
}

export async function createOrganization(db: PrismaClient) {
  const id = randomUUID()
  const organization = await db.organization.create({ data: { name: 'Integration group test', slug: `test-${id}` } })
  const account = await db.account.create({ data: { email: `${id}@example.invalid`, displayName: 'Test employee' } })
  await db.membership.create({ data: { organizationId: organization.id, accountId: account.id, role: 'ORG_ADMIN' } })
  return { organization, account, actor: { organizationId: organization.id, sub: account.id, role: 'ORG_ADMIN' as const, tokenVersion: 1 } }
}
