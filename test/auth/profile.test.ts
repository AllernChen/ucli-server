import 'reflect-metadata'
import { ForbiddenException } from '@nestjs/common'
import argon2 from 'argon2'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { describe, expect, it } from 'vitest'
import { AuthService } from '../../apps/api/src/auth.service.js'
import { UpdateProfileDto } from '../../apps/api/src/profile.dto.js'

const actor = { sub: 'account-1', organizationId: 'org-1', role: 'ORG_ADMIN' as const, tokenVersion: 1 }

function harness(options: { pending?: boolean } = {}) {
  const state = {
    account: { id: actor.sub, displayName: 'Existing user', email: 'user@example.invalid', status: 'ACTIVE',
      passwordHash: 'secret-hash' as string | null, pendingCredentialChange: options.pending ?? false, tokenVersion: 1 },
    organization: { id: actor.organizationId, name: 'Current organization' }, audits: [] as any[]
  }
  const db: any = {
    account: {
      findUnique: async () => ({ ...state.account }),
      findUniqueOrThrow: async () => ({ ...state.account }),
      update: async ({ data }: any) => {
        if (data.email === 'taken@example.invalid') { const error: any = new Error('Unique'); error.code = 'P2002'; throw error }
        const { tokenVersion, ...fields } = data
        Object.assign(state.account, fields)
        if (data.tokenVersion?.increment) state.account.tokenVersion += data.tokenVersion.increment
        return { ...state.account }
      }
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
      id: actor.sub, displayName: 'Existing user', email: 'user@example.invalid', status: 'ACTIVE', pendingCredentialChange: false,
      organizationId: actor.organizationId, organizationName: 'Current organization', role: 'ORG_ADMIN'
    })
    const pending = harness({ pending: true })
    await expect(pending.service.me(actor)).resolves.toMatchObject({ pendingCredentialChange: true })
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

  it('lets a first-time user set their own password and optionally replace the placeholder email', async () => {
    const { service, state } = harness({ pending: true })
    state.account.passwordHash = await argon2.hash('initial-pass-123')
    const result = await service.updateInitialCredentials(actor, { currentPassword: 'initial-pass-123', newPassword: 'brand-new-pass', newEmail: ' Real@Example.COM ' })
    expect(result).toEqual({ email: 'real@example.com' })
    expect(state.account).toMatchObject({ email: 'real@example.com', pendingCredentialChange: false, tokenVersion: 2 })
    expect(await argon2.verify(state.account.passwordHash!, 'brand-new-pass')).toBe(true)
    expect(state.audits).toEqual([expect.objectContaining({
      action: 'account.initial_credentials_updated', metadata: { emailChanged: true } })])

    const keep = harness({ pending: true })
    keep.state.account.passwordHash = await argon2.hash('initial-pass-123')
    await expect(keep.service.updateInitialCredentials(actor, { currentPassword: 'initial-pass-123', newPassword: 'brand-new-pass', newEmail: '' }))
      .resolves.toEqual({ email: 'user@example.invalid' })
    expect(keep.state.account.email).toBe('user@example.invalid')
  })

  it('rejects first-login updates with bad passwords, cleared flags, duplicates or device sessions', async () => {
    const ready = harness({ pending: true })
    ready.state.account.passwordHash = await argon2.hash('initial-pass-123')
    await expect(ready.service.updateInitialCredentials(actor, { currentPassword: 'wrong', newPassword: 'brand-new-pass' }))
      .rejects.toMatchObject({ status: 401 })
    await expect(ready.service.updateInitialCredentials(actor, { currentPassword: 'initial-pass-123', newPassword: 'short' }))
      .rejects.toMatchObject({ status: 400 })
    await expect(ready.service.updateInitialCredentials({ ...actor, deviceId: 'device-1' }, { currentPassword: 'initial-pass-123', newPassword: 'brand-new-pass' }))
      .rejects.toBeInstanceOf(ForbiddenException)
    expect(ready.state.audits).toEqual([])

    const duplicate = harness({ pending: true })
    duplicate.state.account.passwordHash = await argon2.hash('initial-pass-123')
    await expect(duplicate.service.updateInitialCredentials(actor, { currentPassword: 'initial-pass-123', newPassword: 'brand-new-pass', newEmail: 'taken@example.invalid' }))
      .rejects.toMatchObject({ status: 409 })

    const settled = harness({ pending: false })
    settled.state.account.passwordHash = await argon2.hash('initial-pass-123')
    await expect(settled.service.updateInitialCredentials(actor, { currentPassword: 'initial-pass-123', newPassword: 'brand-new-pass' }))
      .rejects.toMatchObject({ status: 401 })
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
