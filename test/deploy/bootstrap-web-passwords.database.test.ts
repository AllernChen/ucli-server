import argon2 from 'argon2'
import { describe, expect, it, vi } from 'vitest'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { applyPasswordBootstrap } from '../../scripts/bootstrap-web-passwords.mjs'
import { createOrganization, withTestDatabase } from '../integration/database.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('web password bootstrap database apply', () => {
  it('sets a forced-change password for key-only active members', async () => {
    vi.stubEnv('MASTER_KEY', Buffer.alloc(32, 41).toString('base64'))
    await withTestDatabase(async db => {
      const { account } = await createOrganization(db)
      const result = await applyPasswordBootstrap(db as PrismaService, [{
        id: account.id, email: account.email, displayName: account.displayName, status: 'ACTIVE', passwordHash: null
      }])
      expect(result.changed).toBe(1)
      const updated = await db.account.findUniqueOrThrow({ where: { id: account.id } })
      expect(updated.pendingCredentialChange).toBe(true)
      expect(updated.tokenVersion).toBe(2)
      await expect(argon2.verify(updated.passwordHash!, result.rows[0].initialPassword)).resolves.toBe(true)
    })
  })
})
