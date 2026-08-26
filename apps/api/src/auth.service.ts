import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common'
import { Role } from '@prisma/client'
import argon2 from 'argon2'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { hashOpaqueToken } from '../../../packages/security/src/tokens.js'
import { authorizationFailure, signAccessToken } from '../../../packages/security/src/auth.js'
import { deviceGrantFailure } from '../../../packages/security/src/device-grants.js'

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

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
      where: { email: input.email.toLowerCase() }, include: { memberships: true }
    })
    if (!account || account.status !== 'ACTIVE' || !account.passwordHash || !await argon2.verify(account.passwordHash, input.password)) {
      throw new UnauthorizedException('Invalid credentials')
    }
    const membership = account.memberships[0]
    if (!membership) throw new UnauthorizedException('No organization membership')
    const organization = await this.prisma.organization.findUnique({ where: { id: membership.organizationId } })
    if (!organization?.enabled) throw new UnauthorizedException('Organization is inactive')
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
      if (!membership || membership.role !== Role.MEMBER || membership.status !== 'ACTIVE') throw authorizationFailure('account_inactive')
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
