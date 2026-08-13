import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common'
import { Role } from '@prisma/client'
import argon2 from 'argon2'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { createDeviceCode, hashOpaqueToken } from '../../../packages/security/src/tokens.js'
import { signAccessToken } from '../../../packages/security/src/auth.js'

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
    if (!account || account.status !== 'ACTIVE' || !await argon2.verify(account.passwordHash, input.password)) {
      throw new UnauthorizedException('Invalid credentials')
    }
    const membership = account.memberships[0]
    if (!membership) throw new UnauthorizedException('No organization membership')
    const organization = await this.prisma.organization.findUnique({ where: { id: membership.organizationId } })
    if (!organization?.enabled) throw new UnauthorizedException('Organization is inactive')
    return { accessToken: signAccessToken({ sub: account.id, organizationId: membership.organizationId, role: membership.role, tokenVersion: account.tokenVersion }) }
  }

  async acceptInvitation(input: { token: string; password?: string; currentPassword?: string; displayName: string }) {
    const invitation = await this.prisma.invitation.findUnique({ where: { tokenHash: hashOpaqueToken(input.token) } })
    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) throw new BadRequestException('Invitation is invalid')
    const existing = await this.prisma.account.findUnique({ where: { email: invitation.email } })
    if (existing && (existing.status !== 'ACTIVE' || !input.currentPassword || !await argon2.verify(existing.passwordHash, input.currentPassword))) {
      throw new UnauthorizedException('Existing account authentication is required')
    }
    if (!existing && !input.password) throw new BadRequestException('Password is required for a new account')
    const passwordHash = existing ? null : await argon2.hash(input.password!)
    return this.prisma.$transaction(async transaction => {
      const claimed = await transaction.invitation.updateMany({ where: { id: invitation.id, acceptedAt: null }, data: { acceptedAt: new Date() } })
      if (claimed.count !== 1) throw new BadRequestException('Invitation is already accepted')
      const account = existing || await transaction.account.create({ data: {
        email: invitation.email, displayName: input.displayName, passwordHash: passwordHash!
      } })
      await transaction.membership.upsert({ where: { organizationId_accountId: {
        organizationId: invitation.organizationId, accountId: account.id
      } }, create: { organizationId: invitation.organizationId, accountId: account.id, role: invitation.role }, update: { role: invitation.role } })
      return { accountId: account.id, organizationId: invitation.organizationId }
    })
  }

  async startDevice(deviceName: string) {
    const code = createDeviceCode()
    await this.prisma.deviceAuthorization.create({ data: {
      deviceCodeHash: hashOpaqueToken(code.deviceCode), userCode: code.userCode,
      deviceName: deviceName.slice(0, 120), expiresAt: new Date(Date.now() + 10 * 60_000)
    } })
    return { ...code, verificationUri: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/device`, expiresIn: 600, interval: 5 }
  }

  async approveDevice(userCode: string, accountId: string) {
    const authorization = await this.prisma.deviceAuthorization.findUnique({ where: { userCode } })
    if (!authorization || authorization.expiresAt <= new Date() || authorization.status !== 'PENDING') {
      throw new BadRequestException('Device authorization is invalid')
    }
    await this.prisma.deviceAuthorization.update({ where: { id: authorization.id }, data: { accountId, status: 'APPROVED' } })
    return { approved: true }
  }

  async pollDevice(deviceCode: string) {
    const authorization = await this.prisma.deviceAuthorization.findUnique({ where: { deviceCodeHash: hashOpaqueToken(deviceCode) } })
    if (!authorization || authorization.expiresAt <= new Date()) throw new BadRequestException('expired_token')
    if (authorization.status !== 'APPROVED' || !authorization.accountId) return { status: 'authorization_pending' }
    const membership = await this.prisma.membership.findFirst({ where: { accountId: authorization.accountId, organization: { enabled: true } } })
    if (!membership) throw new BadRequestException('membership_missing')
    const account = await this.prisma.account.findFirst({ where: { id: authorization.accountId, status: 'ACTIVE' } })
    if (!account) throw new BadRequestException('account_inactive')
    const refreshToken = randomBytes(32).toString('base64url')
    const device = await this.prisma.device.create({ data: {
      accountId: authorization.accountId, organizationId: membership.organizationId,
      name: authorization.deviceName, refreshTokenHash: hashOpaqueToken(refreshToken)
    } })
    await this.prisma.deviceAuthorization.update({ where: { id: authorization.id }, data: { status: 'CONSUMED' } })
    return {
      accessToken: signAccessToken({ sub: authorization.accountId, organizationId: membership.organizationId, deviceId: device.id, role: membership.role, tokenVersion: account.tokenVersion }),
      refreshToken, expiresIn: 900
    }
  }

  async refresh(refreshToken: string) {
    const device = await this.prisma.device.findUnique({
      where: { refreshTokenHash: hashOpaqueToken(refreshToken) },
      include: { organization: true, account: { include: { memberships: true } } }
    })
    if (!device || device.revokedAt || device.account.status !== 'ACTIVE' || !device.organization.enabled) throw new UnauthorizedException('Refresh token is invalid')
    const membership = device.account.memberships.find(item => item.organizationId === device.organizationId)
    if (!membership) throw new UnauthorizedException('Organization membership is inactive')
    const nextRefreshToken = randomBytes(32).toString('base64url')
    await this.prisma.device.update({ where: { id: device.id }, data: {
      refreshTokenHash: hashOpaqueToken(nextRefreshToken), lastSeenAt: new Date()
    } })
    return {
      accessToken: signAccessToken({ sub: device.accountId, organizationId: device.organizationId, deviceId: device.id, role: membership.role, tokenVersion: device.account.tokenVersion }),
      refreshToken: nextRefreshToken, expiresIn: 900
    }
  }
}
