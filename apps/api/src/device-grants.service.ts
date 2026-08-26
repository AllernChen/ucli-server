import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Role } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { deriveDeviceGrantStatus } from '../../../packages/security/src/device-grants.js'
import { createOpaqueToken, hashOpaqueToken, opaqueTokenHint } from '../../../packages/security/src/tokens.js'
import type { CreateDeviceGrantDto, DeviceGrantPageQueryDto, UpdateDeviceGrantDto } from './device-grants.dto.js'
import { DeviceGrantFilter } from './device-grants.dto.js'

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

@Injectable()
export class DeviceGrantsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, actorId: string, accountId: string, input: CreateDeviceGrantDto) {
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_accountId: { organizationId, accountId } },
      select: { role: true, status: true, account: { select: { status: true } } }
    })
    if (!membership) throw new NotFoundException('Managed user not found')
    if (membership.role !== Role.MEMBER || membership.status !== 'ACTIVE' || membership.account.status !== 'ACTIVE') {
      throw new ForbiddenException('Managed user is inactive')
    }

    const expiresAt = parseExpiry(input.expiresAt, false)
    const token = createOpaqueToken()
    const grant = await this.prisma.deviceGrant.create({ data: {
      organizationId, accountId, createdById: actorId, expiresAt,
      tokenHash: hashOpaqueToken(token), tokenHint: opaqueTokenHint(token)
    }, select: { id: true, expiresAt: true } })
    const origin = new URL(process.env.PUBLIC_URL || 'http://localhost:3000').origin
    return { id: grant.id, token, connectionUrl: `${origin}/connect#token=${encodeURIComponent(token)}`, expiresAt: grant.expiresAt }
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

  async updateExpiration(organizationId: string, grantId: string, expiresAtInput: UpdateDeviceGrantDto['expiresAt']) {
    const expiresAt = parseExpiry(expiresAtInput, true)
    const updated = await this.prisma.deviceGrant.updateMany({
      where: { id: grantId, organizationId, deletedAt: null }, data: { expiresAt }
    })
    if (updated.count !== 1) throw new NotFoundException('Device grant not found')
    return { id: grantId, expiresAt }
  }

  async disable(organizationId: string, grantId: string) {
    const disabledAt = new Date()
    const updated = await this.prisma.deviceGrant.updateMany({
      where: { id: grantId, organizationId, deletedAt: null }, data: { disabledAt }
    })
    if (updated.count !== 1) throw new NotFoundException('Device grant not found')
    return { id: grantId, disabledAt }
  }

  async enable(organizationId: string, grantId: string) {
    const updated = await this.prisma.deviceGrant.updateMany({
      where: { id: grantId, organizationId, deletedAt: null }, data: { disabledAt: null }
    })
    if (updated.count !== 1) throw new NotFoundException('Device grant not found')
    return { id: grantId, disabledAt: null }
  }

  async delete(organizationId: string, grantId: string) {
    const deletedAt = new Date()
    return this.prisma.$transaction(async transaction => {
      const grant = await transaction.deviceGrant.findFirst({
        where: { id: grantId, organizationId, deletedAt: null }, select: { id: true, deviceId: true }
      })
      if (!grant) throw new NotFoundException('Device grant not found')
      const updated = await transaction.deviceGrant.updateMany({
        where: { id: grantId, organizationId, deletedAt: null }, data: { deletedAt }
      })
      if (updated.count !== 1) throw new NotFoundException('Device grant not found')
      if (grant.deviceId) {
        await transaction.device.updateMany({ where: { id: grant.deviceId, organizationId }, data: { revokedAt: deletedAt } })
      }
      return { id: grantId, deletedAt }
    })
  }
}
