import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common'
import { Role } from '@prisma/client'
import argon2 from 'argon2'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { hashOpaqueToken } from '../../../packages/security/src/tokens.js'
import { authorizationFailure, signAccessToken, type AuthPrincipal } from '../../../packages/security/src/auth.js'
import { deviceGrantFailure } from '../../../packages/security/src/device-grants.js'
import { assertDeviceGroup } from '../../../packages/security/src/group-access.js'

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async me(actor: AuthPrincipal) {
    this.assertWebSession(actor)
    const [account, organization] = await Promise.all([
      this.prisma.account.findUniqueOrThrow({ where: { id: actor.sub }, select: { id: true, displayName: true, email: true, status: true, pendingCredentialChange: true } }),
      this.prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { name: true } })
    ])
    return this.profile(actor, account, organization.name)
  }

  async updateProfile(actor: AuthPrincipal, input: { displayName: string }) {
    this.assertWebSession(actor)
    return this.prisma.$transaction(async db => {
      const account = await db.account.update({ where: { id: actor.sub }, data: { displayName: input.displayName },
        select: { id: true, displayName: true, email: true, status: true } })
      await db.auditLog.create({ data: { actorAccountId: actor.sub, organizationId: actor.organizationId,
        action: 'account.profile.update', resourceType: 'account', resourceId: actor.sub, metadata: { displayName: input.displayName } } })
      const organization = await db.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { name: true } })
      return this.profile(actor, account, organization.name)
    })
  }

  private assertWebSession(actor: AuthPrincipal) {
    if (actor.deviceId) throw new ForbiddenException('Web login required')
  }

  private profile(actor: AuthPrincipal, account: { id: string; displayName: string; email: string; status: string; pendingCredentialChange?: boolean }, organizationName: string) {
    return { id: account.id, displayName: account.displayName, email: account.email, status: account.status,
      pendingCredentialChange: Boolean(account.pendingCredentialChange),
      organizationId: actor.organizationId, organizationName, role: actor.role }
  }

  async updateInitialCredentials(actor: AuthPrincipal, input: { currentPassword: string; newPassword: string; newEmail?: string }) {
    this.assertWebSession(actor)
    if (input.newPassword.length < 8) throw new BadRequestException('New password must be at least 8 characters')
    const account = await this.prisma.account.findUnique({ where: { id: actor.sub } })
    if (!account || account.status !== 'ACTIVE' || !account.pendingCredentialChange || !account.passwordHash ||
        !await argon2.verify(account.passwordHash, input.currentPassword)) {
      throw new UnauthorizedException('Invalid credentials')
    }
    const passwordHash = await argon2.hash(input.newPassword)
    let email: string | null = input.newEmail ? String(input.newEmail).trim().toLowerCase() : null
    if (email === account.email) email = null
    try {
      await this.prisma.$transaction(async db => {
        await db.account.update({ where: { id: actor.sub }, data: {
          passwordHash, tokenVersion: { increment: 1 }, pendingCredentialChange: false, ...(email ? { email } : {}) } })
        await db.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub,
          action: 'account.initial_credentials_updated', resourceType: 'account', resourceId: actor.sub,
          metadata: { emailChanged: Boolean(email) } } })
      })
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
        throw new ConflictException('Account email already exists')
      }
      throw error
    }
    return { email: email || account.email }
  }

  async setup(input: { email: string; password: string; displayName: string; organizationName: string }, presentedSecret?: string) {
    const expectedSecret = process.env.SETUP_SECRET
    if (!expectedSecret || !presentedSecret || expectedSecret.length !== presentedSecret.length ||
      !timingSafeEqual(Buffer.from(expectedSecret), Buffer.from(presentedSecret))) {
      throw new UnauthorizedException('Setup secret is invalid')
    }
    const passwordHash = await argon2.hash(input.password)
    const slug = input.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default'
    return this.prisma.$transaction(async transaction => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(8625441)`
      if (await transaction.account.count()) throw new BadRequestException('Platform is already initialized')
      const organization = await transaction.organization.create({ data: { name: input.organizationName, slug } })
      const account = await transaction.account.create({ data: {
        email: input.email.toLowerCase(), displayName: input.displayName, passwordHash
      } })
      await transaction.membership.create({ data: { organizationId: organization.id, accountId: account.id, role: Role.PLATFORM_ADMIN } })
      return { organizationId: organization.id, accountId: account.id }
    })
  }

  async login(input: { email: string; password: string }) {
    const account = await this.prisma.account.findUnique({
      where: { email: input.email.toLowerCase() }, include: { memberships: { include: { organization: true } } }
    })
    if (!account || account.status !== 'ACTIVE' || !account.passwordHash || !await argon2.verify(account.passwordHash, input.password)) {
      throw new UnauthorizedException('Invalid credentials')
    }
    const rolePriority: Record<Role, number> = { [Role.PLATFORM_ADMIN]: 0, [Role.ORG_ADMIN]: 1, [Role.MEMBER]: 2 }
    const membership = account.memberships
      .filter(item => item.status === 'ACTIVE' && item.organization.enabled)
      .sort((left, right) => rolePriority[left.role] - rolePriority[right.role] ||
        (left.organizationId < right.organizationId ? -1 : left.organizationId > right.organizationId ? 1 : 0))[0]
    if (!membership) throw new UnauthorizedException('No active organization membership')
    return { accessToken: signAccessToken({ sub: account.id, organizationId: membership.organizationId, role: membership.role, tokenVersion: account.tokenVersion }) }
  }

  async changePassword(accountId: string, input: { currentPassword: string; newPassword: string }) {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } })
    if (!account || account.status !== 'ACTIVE' || !account.passwordHash || !await argon2.verify(account.passwordHash, input.currentPassword)) {
      throw new UnauthorizedException('Current password is incorrect')
    }
    if (input.newPassword.length < 8) throw new BadRequestException('New password must be at least 8 characters')
    const passwordHash = await argon2.hash(input.newPassword)
    await this.prisma.account.update({ where: { id: accountId }, data: { passwordHash, tokenVersion: { increment: 1 } } })
    return { message: 'Password changed' }
  }

  async refresh(refreshToken: string) {
    const oldRefreshTokenHash = hashOpaqueToken(refreshToken)
    return this.prisma.$transaction(async transaction => {
      const device = await transaction.device.findUnique({
        where: { refreshTokenHash: oldRefreshTokenHash },
        include: { grant: true, organization: true, account: { include: { memberships: true } } }
      })
      if (!device?.grant) throw authorizationFailure('invalid_grant')
      const now = new Date()
      const failure = deviceGrantFailure(device.grant, now)
      if (failure) throw authorizationFailure(failure)
      if (device.revokedAt) throw authorizationFailure('invalid_device')
      if (device.account.status !== 'ACTIVE') throw authorizationFailure('account_inactive')
      if (!device.organization.enabled) throw authorizationFailure('organization_inactive')
      const membership = device.account.memberships.find(item => item.organizationId === device.organizationId)
      if (!membership || membership.status !== 'ACTIVE') throw authorizationFailure('account_inactive')
      await assertDeviceGroup(transaction, { organizationId: device.organizationId, accountId: device.accountId, groupId: device.grant.groupId }, device.organization.requireDeviceGroup)
      const nextRefreshToken = randomBytes(32).toString('base64url')
      const rotated = await transaction.device.updateMany({ where: { id: device.id, refreshTokenHash: oldRefreshTokenHash }, data: {
        refreshTokenHash: hashOpaqueToken(nextRefreshToken), lastSeenAt: now
      } })
      if (rotated.count !== 1) throw authorizationFailure('invalid_grant')
      return {
        accessToken: signAccessToken({ sub: device.accountId, organizationId: device.organizationId, deviceId: device.id, role: membership.role, tokenVersion: device.account.tokenVersion }),
        refreshToken: nextRefreshToken, expiresIn: 900,
        authorization: { expiresAt: device.grant.expiresAt?.toISOString() ?? null, serverTime: now.toISOString() }
      }
    })
  }
}
