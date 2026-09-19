import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { EmployeeKeysService } from '../../apps/api/src/employee-keys.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { createOrganization, withTestDatabase } from '../integration/database.js'
import { backfillEmployeeKeySecrets, loadSecretCsv } from '../../scripts/backfill-employee-key-secrets.mjs'

describe('employee key secret backfill', () => {
  it('parses the issuance CSV without exposing values in errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ucli-backfill-'))
    const path = join(directory, 'keys.csv')
    await writeFile(path, '\ufeffemail,keyName,secret\r\nemployee@example.invalid,"项目, Key",ucli_sk_test\r\n', 'utf8')
    try {
      expect(await loadSecretCsv(path)).toEqual([{ email: 'employee@example.invalid', keyName: '项目, Key', secret: 'ucli_sk_test' }])
      await expect(loadSecretCsv(join(directory, 'missing.csv'))).rejects.toThrow('Secret CSV file not found')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it.skipIf(!process.env.TEST_DATABASE_URL)('encrypts legacy secrets only when the hash matches', async () => {
    vi.stubEnv('MASTER_KEY', Buffer.alloc(32, 9).toString('base64'))
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const group = await groups.create(actor, { name: 'Backfill keys', type: 'PROJECT' })
      await groups.addMember(actor, group.id, account.id)
      const created = await keys.create(actor, account.id, { name: 'CLI', groupId: group.id })
      await db.employeeApiKey.update({ where: { id: created.id }, data: { secretCiphertext: null, secretIv: null, secretTag: null } })

      const result = await backfillEmployeeKeySecrets(db as PrismaService, [
        { email: account.email, keyName: 'CLI', secret: created.secret }
      ])
      expect(result).toEqual({ matched: 1, encrypted: 1, alreadyRecoverable: 0 })
      const stored = await db.employeeApiKey.findUniqueOrThrow({ where: { id: created.id } })
      expect(stored.secretCiphertext).toBeTruthy()
      expect(stored.secretCiphertext).not.toBe(created.secret)
      await expect(backfillEmployeeKeySecrets(db as PrismaService, [
        { email: account.email, keyName: 'CLI', secret: 'ucli_sk_wrong' }
      ])).rejects.toThrow('does not match')
    })
  })
})
