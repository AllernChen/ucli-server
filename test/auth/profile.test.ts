import 'reflect-metadata'
import { ForbiddenException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { describe, expect, it } from 'vitest'
import { AuthService } from '../../apps/api/src/auth.service.js'
import { UpdateProfileDto } from '../../apps/api/src/profile.dto.js'

const actor = { sub: 'account-1', organizationId: 'org-1', role: 'ORG_ADMIN' as const, tokenVersion: 1 }

function harness() {
  const state = {
    account: { id: actor.sub, displayName: 'Existing user', email: 'user@example.invalid', status: 'ACTIVE', passwordHash: 'secret-hash' },
    organization: { id: actor.organizationId, name: 'Current organization' }, audits: [] as any[]
  }
  const db: any = {
    account: {
      findUniqueOrThrow: async () => ({ ...state.account }),
      update: async ({ data }: any) => Object.assign(state.account, data)
    },
    organization: { findUniqueOrThrow: async () => ({ ...state.organization }) },
    auditLog: { create: async ({ data }: any) => state.audits.push(data) }
  }
  const prisma: any = { ...db, $transaction: async (work: any) => work(db) }
  return { service: new AuthService(prisma), state }
}

describe('self profile', () => {
  it('returns only the authenticated account profile and safe identity fields', async () => {
    const { service } = harness()
    await expect(service.me(actor)).resolves.toEqual({
      id: actor.sub, displayName: 'Existing user', email: 'user@example.invalid', status: 'ACTIVE',
      organizationId: actor.organizationId, organizationName: 'Current organization', role: 'ORG_ADMIN'
    })
  })

  it('updates only the actor display name and records the change atomically', async () => {
    const { service, state } = harness()
    await expect(service.updateProfile(actor, { displayName: 'Renamed', email: 'attacker@example.invalid', role: 'MEMBER' } as any))
      .resolves.toMatchObject({ displayName: 'Renamed', email: 'user@example.invalid', role: 'ORG_ADMIN' })
    expect(state.account).toMatchObject({ displayName: 'Renamed', email: 'user@example.invalid', passwordHash: 'secret-hash' })
    expect(state.audits).toEqual([expect.objectContaining({
      actorAccountId: actor.sub, organizationId: actor.organizationId, action: 'account.profile.update',
      resourceType: 'account', resourceId: actor.sub, metadata: { displayName: 'Renamed' }
    })])
  })

  it('rejects device sessions before reading or changing a profile', async () => {
    const { service, state } = harness()
    const deviceActor = { ...actor, deviceId: 'device-1' }
    await expect(service.me(deviceActor)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(service.updateProfile(deviceActor, { displayName: 'Nope' })).rejects.toBeInstanceOf(ForbiddenException)
    expect(state.audits).toEqual([])
  })

  it('trims valid names and rejects blank, oversized, and extra profile fields', async () => {
    const valid = plainToInstance(UpdateProfileDto, { displayName: '  张三  ' })
    expect(valid.displayName).toBe('张三')
    expect(await validate(valid)).toEqual([])
    const invalid = plainToInstance(UpdateProfileDto, { displayName: ' ', role: 'PLATFORM_ADMIN' })
    expect((await validate(invalid, { whitelist: true, forbidNonWhitelisted: true })).length).toBeGreaterThan(0)
    const tooLong = plainToInstance(UpdateProfileDto, { displayName: 'x'.repeat(121) })
    expect((await validate(tooLong)).length).toBeGreaterThan(0)
  })
})
