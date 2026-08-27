import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, Role, type Membership } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { deriveDeviceGrantStatus, deviceGrantFailure } from '../../../packages/security/src/device-grants.js'
import { deriveDeviceGrantLinkStatus, deviceGrantLinkFailure } from '../../../packages/security/src/device-grant-links.js'
import { signAccessToken } from '../../../packages/security/src/auth.js'
import { createOpaqueToken, hashOpaqueToken } from '../../../packages/security/src/tokens.js'
import { requirePublicUrl } from '../../../packages/security/src/public-url.js'
import type { CreateDeviceGrantDto, DeviceGrantPageQueryDto, RedeemDeviceGrantDto, UpdateDeviceGrantDto } from './device-grants.dto.js'
import { DeviceGrantFilter } from './device-grants.dto.js'
import { DeviceGrantLinksService, type CreatedDeviceGrantLink } from './device-grant-links.service.js'

type GrantRecord = {
  id: string
  accountId: string
  tokenHint: string
  expiresAt: Date | null
  disabledAt: Date | null
  deletedAt: Date | null
  boundAt: Date | null
  deviceId: string | null
  createdById: string
  createdAt: Date
  updatedAt: Date
  device?: {
    id: string
    name: string
    installationId: string | null
    platform: string | null
    clientVersion: string | null
    revokedAt: Date | null
    lastSeenAt: Date | null
    createdAt: Date
  } | null
}

const previewGrantInclude = Prisma.validator<Prisma.DeviceGrantInclude>()({ account: true, organization: true })
const redemptionGrantInclude = Prisma.validator<Prisma.DeviceGrantInclude>()({ account: true, organization: true, device: true })
type PreviewGrant = Prisma.DeviceGrantGetPayload<{ include: typeof previewGrantInclude }>
type RedemptionGrant = Prisma.DeviceGrantGetPayload<{ include: typeof redemptionGrantInclude }>
type EligibleGrant = PreviewGrant | RedemptionGrant
type GrantMembership = Pick<Membership, 'role' | 'status'>
type KnownGrant = Pick<RedemptionGrant, 'id' | 'organizationId' | 'accountId' | 'expiresAt' | 'deviceId'>
type KnownLink = { secretHint: string }

function parseExpiry(value: string | null | undefined, required: boolean): Date | null {
  if (value === undefined) {
    if (required) throw new BadRequestException('expiresAt is required')
    return null
  }
  if (value === null) return null
  const expiresAt = new Date(value)
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
    throw new BadRequestException('expiresAt must be in the future')
  }
  return expiresAt
}

function parseLinkExpiry(value: string | null | undefined, now: Date): Date | null {
  if (value === undefined) return new Date(now.getTime() + 7 * 24 * 60 * 60_000)
  return parseExpiry(value, false)
}

function serializeLink(link: Omit<CreatedDeviceGrantLink, 'secret'>) {
  return {
    id: link.id,
    secretHint: link.secretHint,
    status: deriveDeviceGrantLinkStatus({ consumedAt: null, revokedAt: null, expiresAt: link.expiresAt }),
    expiresAt: link.expiresAt,
    createdAt: link.createdAt
  }
}

function serializeGrant(grant: GrantRecord, now: Date) {
  return {
    id: grant.id,
    accountId: grant.accountId,
    tokenHint: grant.tokenHint,
    expiresAt: grant.expiresAt,
    disabledAt: grant.disabledAt,
    deletedAt: grant.deletedAt,
    boundAt: grant.boundAt,
    deviceId: grant.deviceId,
    createdById: grant.createdById,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
    status: deriveDeviceGrantStatus(grant, now),
    device: grant.device ? {
      id: grant.device.id,
      name: grant.device.name,
      installationId: grant.device.installationId,
      platform: grant.device.platform,
      clientVersion: grant.device.clientVersion,
      revokedAt: grant.device.revokedAt,
      lastSeenAt: grant.device.lastSeenAt,
      createdAt: grant.device.createdAt
    } : null
  }
}

function grantException(code: string): BadRequestException {
  return new BadRequestException({ code })
}

function validateLink(link: unknown): asserts link is string {
  if (typeof link !== 'string' || link.length < 32 || link.length > 128) throw grantException('invalid_link')
}

function validateDevice(input: RedeemDeviceGrantDto['device']): asserts input is { installationId: string; name: string; platform: string; clientVersion: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw grantException('invalid_device')
  const device = input as Record<string, unknown>
  if (typeof device.installationId !== 'string' || typeof device.name !== 'string' ||
    typeof device.platform !== 'string' || typeof device.clientVersion !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(device.installationId) ||
    !device.name.trim() || device.name.trim().length > 120 || !['windows', 'macos', 'linux'].includes(device.platform) ||
    !device.clientVersion || device.clientVersion.length > 32) {
    throw grantException('invalid_device')
  }
}

function isInstallationIdConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || (error as { code?: unknown }).code !== 'P2002') return false
  const target = (error as { meta?: { target?: unknown } }).meta?.target
  const fields = Array.isArray(target) ? target : [target]
  return fields.some(field => typeof field === 'string' && (field === 'installation_id' || field === 'installationId' || field.includes('installation_id')))
}

@Injectable()
export class DeviceGrantsService {
  constructor(private readonly prisma: PrismaService, private readonly links?: DeviceGrantLinksService) {}

  async create(organizationId: string, actorId: string, accountId: string, input: CreateDeviceGrantDto) {
    const expiresAt = parseExpiry(input.expiresAt, false)
    const now = new Date()
    const linkExpiresAt = parseLinkExpiry(input.linkExpiresAt, now)
    const links = this.links ?? new DeviceGrantLinksService()
    const credential = links.prepareCredential()
    const grant = await this.prisma.$transaction(async transaction => {
      const eligibility = await transaction.$queryRaw<Array<{
        membershipStatus: string
        accountStatus: string
        organizationEnabled: boolean
      }>>(Prisma.sql`
        SELECT
          m."status" AS "membershipStatus",
          a."status" AS "accountStatus",
          o."enabled" AS "organizationEnabled"
        FROM "memberships" m
        JOIN "accounts" a ON a."id" = m."account_id"
        JOIN "organizations" o ON o."id" = m."organization_id"
        WHERE m."organization_id" = ${organizationId}::uuid
          AND m."account_id" = ${accountId}::uuid
        FOR UPDATE OF m, a, o
      `)
      const target = eligibility[0]
      if (!target) throw new NotFoundException('Managed user not found')
      if (target.membershipStatus !== 'ACTIVE' || target.accountStatus !== 'ACTIVE' || !target.organizationEnabled) {
        throw new ForbiddenException('Managed user is inactive')
      }
      const origin = requirePublicUrl()
      const created = await transaction.deviceGrant.create({ data: {
        organizationId, accountId, createdById: actorId, expiresAt,
        tokenHash: credential.secretHash, tokenHint: credential.secretHint
      }, select: { id: true, expiresAt: true, tokenHint: true } })
      const link = await links.createInTransaction(transaction, {
        organizationId, actorId, grantId: created.id, expiresAt: linkExpiresAt, action: 'create', credential
      })
      await this.writeAudit(transaction, actorId, organizationId, created.id, 'create', {
        outcome: 'success', tokenHint: created.tokenHint, expiresAt: created.expiresAt
      })
      return { created, link, origin }
    })
    return {
      id: grant.created.id,
      expiresAt: grant.created.expiresAt,
      currentLink: serializeLink(grant.link),
      connectionUrl: `${grant.origin}/connect#link=${encodeURIComponent(grant.link.secret)}`
    }
  }

  async preview(linkSecret: unknown) {
    validateLink(linkSecret)
    const link = await this.prisma.deviceGrantLink.findUnique({
      where: { secretHash: hashOpaqueToken(linkSecret) },
      include: { deviceGrant: { include: previewGrantInclude } }
    })
    if (!link) throw grantException('invalid_link')
    const now = new Date()
    const linkFailure = deviceGrantLinkFailure(link, now)
    if (linkFailure) throw grantException(linkFailure)
    const grant = link.deviceGrant
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_accountId: { organizationId: grant.organizationId, accountId: grant.accountId } }
    })
    this.assertEligibleGrant(grant, membership)
    return {
      account: { id: grant.account.id, displayName: grant.account.displayName },
      organization: { id: grant.organization.id, name: grant.organization.name },
      link: { status: deriveDeviceGrantLinkStatus(link, now), expiresAt: link.expiresAt },
      authorization: { status: deriveDeviceGrantStatus(grant, now), expiresAt: grant.expiresAt, serverTime: now.toISOString() }
    }
  }

  async redeem(input: RedeemDeviceGrantDto) {
    validateLink(input.link)
    const deviceInput = input.device
    validateDevice(deviceInput)
    const linkHash = hashOpaqueToken(input.link)
    let knownGrant: KnownGrant | null = null
    let knownLink: KnownLink | null = null
    try {
      return await this.prisma.$transaction(async transaction => {
        const lockedLink = await transaction.$queryRaw<Array<{ id: string; deviceGrantId: string }>>(Prisma.sql`
        SELECT "id", "device_grant_id" AS "deviceGrantId"
        FROM "device_grant_links"
        WHERE "secret_hash" = ${linkHash}
        FOR UPDATE
        `)
        if (!lockedLink[0]) throw grantException('invalid_link')
        const link = await transaction.deviceGrantLink.findUnique({ where: { id: lockedLink[0].id } })
        if (!link) throw grantException('invalid_link')
        knownLink = link
        const lockedGrant = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "device_grants"
        WHERE "id" = ${lockedLink[0].deviceGrantId}::uuid
        FOR UPDATE
        `)
        if (!lockedGrant[0]) throw grantException('invalid_link')
        const grant = await transaction.deviceGrant.findUnique({
          where: { id: lockedGrant[0].id },
          include: redemptionGrantInclude
        })
        if (!grant) throw grantException('invalid_link')
        knownGrant = grant
        const now = new Date()
        const linkFailure = deviceGrantLinkFailure(link, now)
        if (linkFailure && linkFailure !== 'link_consumed') throw grantException(linkFailure)
        let device = grant.device
        if (linkFailure === 'link_consumed') {
          if (!device || device.installationId !== deviceInput.installationId || device.revokedAt || !grant.redeemRetryUntil || grant.redeemRetryUntil <= now) {
            throw grantException('link_consumed')
          }
          const membership = await transaction.membership.findUnique({
            where: { organizationId_accountId: { organizationId: grant.organizationId, accountId: grant.accountId } }
          })
          const role = this.assertEligibleGrant(grant, membership)
          const refreshToken = createOpaqueToken()
          await transaction.device.update({ where: { id: device.id }, data: { refreshTokenHash: hashOpaqueToken(refreshToken), lastSeenAt: now } })
          await this.writeAudit(transaction, grant.accountId, grant.organizationId, grant.id, 'redeem', {
            outcome: 'success', secretHint: link.secretHint, deviceId: device.id, expiresAt: grant.expiresAt, mode: 'idempotent_retry'
          })
          return this.credentials(grant, role, device.id, refreshToken, now)
        }
        const membership = await transaction.membership.findUnique({
          where: { organizationId_accountId: { organizationId: grant.organizationId, accountId: grant.accountId } }
        })
        const role = this.assertEligibleGrant(grant, membership)

        if (!grant.deviceId) {
          const existingDevice = await transaction.device.findFirst({ where: { installationId: deviceInput.installationId, revokedAt: null } })
          if (existingDevice) throw grantException('invalid_device')
          const refreshToken = createOpaqueToken()
          device = await transaction.device.create({ data: {
            organizationId: grant.organizationId, accountId: grant.accountId,
            installationId: deviceInput.installationId, name: deviceInput.name.trim(), platform: deviceInput.platform,
            clientVersion: deviceInput.clientVersion, refreshTokenHash: hashOpaqueToken(refreshToken)
          } })
          await transaction.deviceGrant.update({ where: { id: grant.id }, data: {
            deviceId: device.id, boundAt: now, redeemRetryUntil: new Date(now.getTime() + 10 * 60_000)
          } })
          await transaction.deviceGrantLink.update({ where: { id: link.id }, data: { consumedAt: now, secretEncrypted: Prisma.DbNull } })
          await this.writeAudit(transaction, grant.accountId, grant.organizationId, grant.id, 'redeem', {
            outcome: 'success', secretHint: link.secretHint, deviceId: device.id, expiresAt: grant.expiresAt, mode: 'first_bind'
          })
          return this.credentials(grant, role, device.id, refreshToken, now)
        }
        throw grantException('link_consumed')
      })
    } catch (error) {
      const finalError = isInstallationIdConflict(error) ? grantException('invalid_device') : error
      if (knownGrant && knownLink) await this.writeFailureAudit(knownGrant, knownLink, finalError)
      throw finalError
    }
  }

  private assertEligibleGrant(grant: EligibleGrant, membership: GrantMembership | null, enforceLifecycle = true): Role {
    const failure = deviceGrantFailure(grant)
    if (enforceLifecycle && failure) throw grantException(failure)
    if (grant.account.status !== 'ACTIVE') throw grantException('account_inactive')
    if (!grant.organization.enabled) throw grantException('organization_inactive')
    if (!membership) throw grantException('invalid_grant')
    if (membership.status !== 'ACTIVE') throw grantException('account_inactive')
    return membership.role
  }

  private credentials(grant: RedemptionGrant, role: Role, deviceId: string, refreshToken: string, now: Date) {
    return {
      accessToken: signAccessToken({
        sub: grant.accountId, organizationId: grant.organizationId, deviceId, role, tokenVersion: grant.account.tokenVersion
      }),
      refreshToken,
      expiresIn: 900,
      account: { id: grant.account.id, displayName: grant.account.displayName },
      organization: { id: grant.organization.id, name: grant.organization.name },
      authorization: { expiresAt: grant.expiresAt, serverTime: now.toISOString() }
    }
  }

  async listGrouped(organizationId: string, query: DeviceGrantPageQueryDto) {
    const now = new Date()
    const activeExpiry = [{ expiresAt: null }, { expiresAt: { gt: now } }]
    const statusWhere: Record<Exclude<DeviceGrantFilter, DeviceGrantFilter.ALL>, any> = {
      AVAILABLE: { deletedAt: null, disabledAt: null, OR: activeExpiry, deviceId: null },
      BOUND: { deletedAt: null, disabledAt: null, OR: activeExpiry, deviceId: { not: null } },
      DISABLED: { deletedAt: null, disabledAt: { not: null } },
      EXPIRED: { deletedAt: null, disabledAt: null, expiresAt: { lte: now } },
      DELETED: { deletedAt: { not: null } }
    }
    const grantWhere = { organizationId, ...(query.status === DeviceGrantFilter.ALL ? { deletedAt: null } : statusWhere[query.status]) }
    const q = query.q?.trim()
    const membershipWhere = {
      organizationId,
      account: {
        deviceGrants: { some: grantWhere },
        ...(q ? { OR: [
          { email: { contains: q, mode: 'insensitive' as const } },
          { displayName: { contains: q, mode: 'insensitive' as const } }
        ] } : {})
      }
    }
    const [memberships, total] = await Promise.all([
      this.prisma.membership.findMany({
        where: membershipWhere, skip: query.offset, take: query.limit, orderBy: { account: { createdAt: 'desc' } },
        select: { account: { select: { id: true, email: true, displayName: true } } }
      }),
      this.prisma.membership.count({ where: membershipWhere })
    ])
    const accountIds = memberships.map(membership => membership.account.id)
    const grants = accountIds.length ? await this.prisma.deviceGrant.findMany({
      where: { ...grantWhere, accountId: { in: accountIds } }, orderBy: { createdAt: 'desc' },
      select: {
        id: true, accountId: true, tokenHint: true, expiresAt: true, disabledAt: true, deletedAt: true,
        boundAt: true, deviceId: true, createdById: true, createdAt: true, updatedAt: true,
        device: { select: {
          id: true, name: true, installationId: true, platform: true, clientVersion: true,
          revokedAt: true, lastSeenAt: true, createdAt: true
        } }
      }
    }) : []
    return {
      items: memberships.map(membership => ({
        id: membership.account.id, email: membership.account.email, displayName: membership.account.displayName,
        deviceGrants: grants.filter(grant => grant.accountId === membership.account.id).map(grant => serializeGrant(grant, now))
      })),
      total, limit: query.limit, offset: query.offset
    }
  }

  async updateExpiration(organizationId: string, actorId: string, grantId: string, expiresAtInput: UpdateDeviceGrantDto['expiresAt']) {
    const expiresAt = parseExpiry(expiresAtInput, true)
    await this.auditLifecycle(organizationId, actorId, grantId, 'update_expiration', { expiresAt }, { expiresAt })
    return { id: grantId, expiresAt }
  }

  async disable(organizationId: string, actorId: string, grantId: string) {
    const disabledAt = new Date()
    await this.auditLifecycle(organizationId, actorId, grantId, 'disable', { disabledAt }, { disabledAt })
    return { id: grantId, disabledAt }
  }

  async enable(organizationId: string, actorId: string, grantId: string) {
    await this.auditLifecycle(organizationId, actorId, grantId, 'enable', { disabledAt: null }, { disabledAt: null })
    return { id: grantId, disabledAt: null }
  }

  async delete(organizationId: string, actorId: string, grantId: string) {
    const deletedAt = new Date()
    return this.prisma.$transaction(async transaction => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "device_grants"
        WHERE "id" = ${grantId}::uuid AND "organization_id" = ${organizationId}::uuid
        FOR UPDATE
      `)
      const grant = await transaction.deviceGrant.findFirst({
        where: { id: grantId, organizationId }, select: { id: true, deviceId: true, deletedAt: true }
      })
      if (!grant || grant.deletedAt) throw new NotFoundException('Device grant not found')
      const updated = await transaction.deviceGrant.updateMany({
        where: { id: grantId, organizationId, deletedAt: null }, data: { deletedAt }
      })
      if (updated.count !== 1) throw new NotFoundException('Device grant not found')
      if (grant.deviceId) {
        await transaction.device.updateMany({ where: { id: grant.deviceId, organizationId }, data: { revokedAt: deletedAt } })
      }
      await this.writeAudit(transaction, actorId, organizationId, grantId, 'delete', { outcome: 'success', deviceId: grant.deviceId, deletedAt })
      return { id: grantId, deletedAt }
    })
  }

  private async auditLifecycle(organizationId: string, actorId: string, grantId: string, action: string, data: Record<string, unknown>, metadata: Record<string, unknown>) {
    await this.prisma.$transaction(async transaction => {
      const grant = await transaction.deviceGrant.findFirst({ where: { id: grantId, organizationId, deletedAt: null }, select: { id: true, tokenHint: true } })
      if (!grant) throw new NotFoundException('Device grant not found')
      const updated = await transaction.deviceGrant.updateMany({ where: { id: grantId, organizationId, deletedAt: null }, data })
      if (updated.count !== 1) throw new NotFoundException('Device grant not found')
      await this.writeAudit(transaction, actorId, organizationId, grantId, action, { outcome: 'success', tokenHint: grant.tokenHint, ...metadata })
    })
  }

  private async writeAudit(transaction: any, actorAccountId: string | null, organizationId: string, resourceId: string, action: string, metadata: Record<string, unknown>) {
    // Prisma always exposes auditLog; this keeps lightweight legacy unit harnesses focused on their target behavior.
    if (!transaction.auditLog) return
    await transaction.auditLog.create({ data: { actorAccountId, organizationId, action: `device_grant.${action}`, resourceType: 'device_grant', resourceId, metadata } })
  }

  private async writeFailureAudit(grant: KnownGrant, link: KnownLink, error: unknown) {
    const response = typeof error === 'object' && error !== null && 'getResponse' in error && typeof (error as any).getResponse === 'function' ? (error as any).getResponse() : null
    const code = typeof response === 'object' && response !== null && 'code' in response && typeof (response as any).code === 'string' ? (response as any).code : 'redemption_failed'
    try {
      if (!this.prisma.auditLog) return
      await this.prisma.auditLog.create({ data: { actorAccountId: grant.accountId, organizationId: grant.organizationId, action: 'device_grant.redeem', resourceType: 'device_grant', resourceId: grant.id, metadata: { outcome: 'failure', code, secretHint: link.secretHint, deviceId: grant.deviceId, expiresAt: grant.expiresAt } } })
    } catch (auditError) {
      console.error('device-grant-audit-write-failed', { error: auditError instanceof Error ? auditError.message : String(auditError) })
    }
  }
}
