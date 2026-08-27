import 'reflect-metadata'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { DeviceGrantLinksService } from '../../apps/api/src/device-grant-links.service.js'
import { createDeviceGrantLinkCredential } from '../../packages/security/src/device-grant-links.js'

const masterKey = Buffer.alloc(32, 7)

function code(error: unknown) {
  return (error as BadRequestException).getResponse() as { code: string }
}

function makeHarness(options: Partial<{
  organizationId: string
  boundAt: Date | null
  deviceId: string | null
  disabledAt: Date | null
  deletedAt: Date | null
  expiresAt: Date | null
  linkExpiresAt: Date | null
  secretEncrypted: unknown
}> = {}) {
  process.env.MASTER_KEY = masterKey.toString('base64')
  process.env.PUBLIC_URL = 'https://ucli.example.test'
  const previousCredential = createDeviceGrantLinkCredential(masterKey)
  const createdAt = new Date('2026-08-27T00:00:00.000Z')
  const state = {
    grant: {
      id: 'grant-1', organizationId: options.organizationId ?? 'org-1', boundAt: options.boundAt ?? null,
      deviceId: options.deviceId ?? null, disabledAt: options.disabledAt ?? null, deletedAt: options.deletedAt ?? null,
      expiresAt: options.expiresAt ?? null
    },
    links: [{
      id: 'link-1', deviceGrantId: 'grant-1', createdById: 'actor-0', secretHash: previousCredential.secretHash,
      secretHint: previousCredential.secretHint, secretEncrypted: options.secretEncrypted === undefined ? previousCredential.secretEncrypted : options.secretEncrypted,
      expiresAt: options.linkExpiresAt ?? null, revokedAt: null, consumedAt: null, createdAt
    }] as any[],
    audits: [] as any[]
  }
  const locks = new Map<string, Promise<void>>()
  const calls = { linkCreate: [] as any[], linkUpdates: [] as any[], rowLocks: [] as unknown[][] }
  const linkMatches = (link: any, where: any) =>
    (!where.deviceGrantId || link.deviceGrantId === where.deviceGrantId) &&
    (where.revokedAt === undefined || link.revokedAt === where.revokedAt) &&
    (where.consumedAt === undefined || link.consumedAt === where.consumedAt)
  const prisma: any = {
    deviceGrant: {
      findFirst: async ({ where }: any) => state.grant.id === where.id && state.grant.organizationId === where.organizationId ? state.grant : null
    },
    deviceGrantLink: {
      findFirst: async ({ where }: any) => state.links.filter(link => linkMatches(link, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
      updateMany: async ({ where, data }: any) => {
        calls.linkUpdates.push({ where, data })
        const matching = state.links.filter(link => linkMatches(link, where))
        matching.forEach(link => Object.assign(link, { ...data, secretEncrypted: data.secretEncrypted === Prisma.DbNull ? null : data.secretEncrypted }))
        return { count: matching.length }
      },
      create: async ({ data }: any) => {
        calls.linkCreate.push(data)
        if (state.links.some(link => link.deviceGrantId === data.deviceGrantId && !link.revokedAt && !link.consumedAt)) {
          throw { code: 'P2002', meta: { target: ['device_grant_links_one_current_per_grant'] } }
        }
        const link = { id: `link-${state.links.length + 1}`, createdAt: new Date(), revokedAt: null, consumedAt: null, ...data }
        state.links.push(link)
        return link
      }
    },
    auditLog: { create: async ({ data }: any) => { state.audits.push(data); return data } },
    $transaction: async (operation: any) => {
      let release: (() => void) | undefined
      const transaction = {
        ...prisma,
        $queryRaw: async (query: any) => {
          const key = `${query.values[0]}:${query.values[1]}`
          const previous = locks.get(key) ?? Promise.resolve()
          const held = new Promise<void>(resolve => { release = resolve })
          locks.set(key, previous.then(() => held))
          await previous
          calls.rowLocks.push(query.values)
          return state.grant.id === query.values[0] && state.grant.organizationId === query.values[1] ? [{ id: state.grant.id }] : []
        }
      }
      try { return await operation(transaction) } finally { release?.() }
    }
  }
  return { links: new DeviceGrantLinksService(prisma), state, calls, previousUrl: `https://ucli.example.test/connect#link=${encodeURIComponent(previousCredential.secret)}` }
}

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

  it('returns the same recoverable URL without rotating it', async () => {
    const { links, calls, state, previousUrl } = makeHarness()

    const first = await links.viewCurrent('org-1', 'actor-1', 'grant-1')
    const second = await links.viewCurrent('org-1', 'actor-1', 'grant-1')

    expect(first.connectionUrl).toBe(previousUrl)
    expect(second.connectionUrl).toBe(first.connectionUrl)
    expect(second.currentLink).toMatchObject({ id: 'link-1', status: 'AVAILABLE' })
    expect(calls.linkCreate).toHaveLength(0)
    expect(state.audits.map(audit => audit.action)).toEqual(['device_grant_link.view', 'device_grant_link.view'])
  })

  it('recovers an expired current URL even if its grant is later disabled', async () => {
    const { links, state, previousUrl } = makeHarness({
      disabledAt: new Date(), linkExpiresAt: new Date(Date.now() - 1)
    })

    await expect(links.viewCurrent('org-1', 'actor-1', 'grant-1')).resolves.toMatchObject({
      connectionUrl: previousUrl, currentLink: { status: 'EXPIRED' }
    })
    expect(state.audits[0].metadata).toMatchObject({ deviceGrantId: 'grant-1', secretHint: state.links[0].secretHint, status: 'EXPIRED' })
  })

  it.each([
    ['another organization', 'org-2', {}],
    ['missing ciphertext', 'org-1', { secretEncrypted: null }],
    ['revoked current link', 'org-1', { secretEncrypted: null }]
  ])('does not disclose a URL for %s', async (_, organizationId, options) => {
    const { links, state } = makeHarness(options)
    if (_ === 'revoked current link') state.links[0].revokedAt = new Date()

    await expect(links.viewCurrent(organizationId, 'actor-1', 'grant-1')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('does not leak the secret when ciphertext cannot be decrypted with the current master key', async () => {
    const { links, previousUrl } = makeHarness()
    process.env.MASTER_KEY = Buffer.alloc(32, 8).toString('base64')
    const wrongKeyService = new DeviceGrantLinksService((links as any).prisma)

    const error = await wrongKeyService.viewCurrent('org-1', 'actor-1', 'grant-1').catch(error => error)

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(previousUrl)
  })

  it('revokes and clears every current ciphertext before inserting one replacement', async () => {
    const { links, state, previousUrl } = makeHarness()

    const result = await links.regenerate('org-1', 'actor-1', 'grant-1', { expiresAt: null })

    expect(result.connectionUrl).not.toBe(previousUrl)
    expect(result.currentLink).toMatchObject({ id: 'link-2', status: 'AVAILABLE', expiresAt: null })
    expect(state.links[0]).toMatchObject({ revokedAt: expect.any(Date), secretEncrypted: null })
    expect(state.links.filter(link => !link.revokedAt && !link.consumedAt)).toHaveLength(1)
    expect(state.audits).toContainEqual(expect.objectContaining({
      action: 'device_grant_link.regenerate', resourceId: 'link-2',
      metadata: expect.objectContaining({ previousLinkId: 'link-1', newLinkId: 'link-2' })
    }))
  })

  it.each([
    ['bound', { boundAt: new Date(), deviceId: 'device-1' }, 'grant_bound'],
    ['disabled', { disabledAt: new Date() }, 'grant_disabled'],
    ['deleted', { deletedAt: new Date() }, 'grant_deleted'],
    ['expired', { expiresAt: new Date(Date.now() - 1) }, 'grant_expired']
  ])('refuses regeneration for a %s grant', async (_, options, expectedCode) => {
    const { links, calls } = makeHarness(options)

    await expect(links.regenerate('org-1', 'actor-1', 'grant-1', { expiresAt: null }))
      .rejects.toSatisfy(error => error instanceof BadRequestException && code(error).code === expectedCode)
    expect(calls.linkCreate).toHaveLength(0)
  })

  it('uses the independent seven-day default and rejects a past URL expiry', async () => {
    const { links } = makeHarness()
    const before = Date.now()

    const result = await links.regenerate('org-1', 'actor-1', 'grant-1', {})
    await expect(links.regenerate('org-1', 'actor-1', 'grant-1', { expiresAt: new Date(Date.now() - 1).toISOString() }))
      .rejects.toBeInstanceOf(BadRequestException)

    expect(result.currentLink.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60_000 - 50)
  })

  it('serializes concurrent regenerations so exactly one current link remains', async () => {
    const { links, state, calls } = makeHarness()

    const results = await Promise.all([
      links.regenerate('org-1', 'actor-1', 'grant-1', { expiresAt: null }),
      links.regenerate('org-1', 'actor-2', 'grant-1', { expiresAt: null })
    ])

    expect(results[0].connectionUrl).not.toBe(results[1].connectionUrl)
    expect(state.links.filter(link => !link.revokedAt && !link.consumedAt)).toHaveLength(1)
    expect(calls.rowLocks).toEqual([['grant-1', 'org-1'], ['grant-1', 'org-1']])
  })

  it('keeps secrets, hashes, ciphertext, and URLs out of link audits', async () => {
    const { links, state, previousUrl } = makeHarness()

    await links.viewCurrent('org-1', 'actor-1', 'grant-1')
    await links.regenerate('org-1', 'actor-1', 'grant-1', { expiresAt: null })

    const auditText = JSON.stringify(state.audits)
    expect(auditText).not.toContain(previousUrl)
    expect(auditText).not.toContain(state.links[0].secretHash)
    expect(auditText).not.toContain(state.links[1].secretHash)
    expect(auditText).not.toContain(JSON.stringify(state.links[1].secretEncrypted))
  })
})
