import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { DeviceGrantLinksService } from '../../apps/api/src/device-grant-links.service.js'

describe('device grant links service', () => {
  it('persists exactly a prepared credential for an initial link', async () => {
    const previousMasterKey = process.env.MASTER_KEY
    process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
    const creates: any[] = []
    try {
      const service = new DeviceGrantLinksService()
      const credential = service.prepareCredential()
      const expiresAt = new Date('2026-09-03T00:00:00.000Z')
      const result = await service.createInTransaction({
        deviceGrantLink: { create: async ({ data }: any) => {
          creates.push(data)
          return { id: 'link-1', createdAt: new Date('2026-08-27T00:00:00.000Z'), ...data }
        } }
      } as any, {
        organizationId: 'org-1', actorId: 'actor-1', grantId: 'grant-1', expiresAt, action: 'create', credential
      })
      expect(creates).toEqual([{
        deviceGrantId: 'grant-1', createdById: 'actor-1', expiresAt,
        secretHash: credential.secretHash, secretHint: credential.secretHint, secretEncrypted: credential.secretEncrypted
      }])
      expect(result).toEqual(expect.objectContaining({ id: 'link-1', secret: credential.secret, secretHint: credential.secretHint, expiresAt }))
    } finally {
      if (previousMasterKey === undefined) delete process.env.MASTER_KEY
      else process.env.MASTER_KEY = previousMasterKey
    }
  })
})
