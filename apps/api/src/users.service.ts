import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { AccountStatus, Role } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { deriveDeviceGrantStatus, type DeviceGrantStatus } from '../../../packages/security/src/device-grants.js'
import { deriveDeviceGrantLinkStatus, type DeviceGrantLinkStatus } from '../../../packages/security/src/device-grant-links.js'
import type { CreateManagedUserDto, ManagedUserPageQueryDto } from './device-grants.dto.js'

export interface ManagedUser {
  id: string
  organizationId: string
  email: string
  displayName: string
  status: 'ACTIVE' | 'DISABLED'
  role: Role
  createdAt: Date
  lastSeenAt: Date | null
  deviceCount: number
  deviceGrantCount: number
}

export interface ManagedUserDetail extends ManagedUser {
  devices: Array<{
    id: string
    name: string
    installationId: string | null
    platform: string | null
    clientVersion: string | null
    revokedAt: Date | null
    lastSeenAt: Date | null
    createdAt: Date
    grant: {
      id: string
      expiresAt: Date | null
      disabledAt: Date | null
      deletedAt: Date | null
      boundAt: Date | null
      deviceId: string | null
      status: DeviceGrantStatus
      currentLink: DeviceGrantLinkSummary | null
    } | null
  }>
  deviceGrants: Array<{
    id: string
    expiresAt: Date | null
    disabledAt: Date | null
    deletedAt: Date | null
    boundAt: Date | null
    deviceId: string | null
    createdAt: Date
    updatedAt: Date
    status: DeviceGrantStatus
    currentLink: DeviceGrantLinkSummary | null
  }>
}

interface DeviceGrantLinkSummary {
  id: string
  secretHint: string
  status: DeviceGrantLinkStatus
  expiresAt: Date | null
  createdAt: Date
}

type GrantWithLatestLink = {
  links: Array<{
    id: string
    secretHint: string
    expiresAt: Date | null
    revokedAt: Date | null
    consumedAt: Date | null
    createdAt: Date
    issuanceOrder: bigint
  }>
}

function serializeCurrentLink(grant: GrantWithLatestLink, now: Date): DeviceGrantLinkSummary | null {
  const link = grant.links[0]
  if (!link) return null
  return {
    id: link.id,
    secretHint: link.secretHint,
    status: deriveDeviceGrantLinkStatus(link, now),
    expiresAt: link.expiresAt,
    createdAt: link.createdAt
  }
}

function normalize(input: Pick<CreateManagedUserDto, 'email' | 'displayName'>) {
  return { email: String(input.email).trim().toLowerCase(), displayName: String(input.displayName).trim() }
}

function isUniqueConstraint(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002'
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, input: CreateManagedUserDto): Promise<ManagedUser> {
    const normalized = normalize(input)
    try {
      return await this.prisma.$transaction(async transaction => {
        const account = await transaction.account.create({ data: { ...normalized, passwordHash: null } })
        const membership = await transaction.membership.create({ data: {
          organizationId, accountId: account.id, role: Role.MEMBER, status: AccountStatus.ACTIVE
        } })
        return {
          id: account.id, organizationId: membership.organizationId, email: account.email, displayName: account.displayName,
          status: membership.status, role: membership.role, createdAt: account.createdAt, lastSeenAt: null, deviceCount: 0, deviceGrantCount: 0
        }
      })
    } catch (error) {
      if (isUniqueConstraint(error)) throw new ConflictException('Account email already exists')
      throw error
    }
  }

  async list(organizationId: string, query: ManagedUserPageQueryDto): Promise<{ items: ManagedUser[]; total: number; limit: number; offset: number }> {
    const q = query.q?.trim()
    const where = {
      organizationId,
      ...(q ? { account: { OR: [
        { email: { contains: q, mode: 'insensitive' as const } },
        { displayName: { contains: q, mode: 'insensitive' as const } }
      ] } } : {})
    }
    const [memberships, total] = await Promise.all([
      this.prisma.membership.findMany({
        where, skip: query.offset, take: query.limit, orderBy: { account: { createdAt: 'desc' } },
        select: {
          organizationId: true, role: true, status: true,
          account: { select: {
            id: true, email: true, displayName: true, createdAt: true,
            _count: { select: { devices: { where: { organizationId } }, deviceGrants: { where: { organizationId } } } },
            devices: { where: { organizationId }, orderBy: { lastSeenAt: { sort: 'desc', nulls: 'last' } }, take: 1, select: { lastSeenAt: true } }
          } }
        }
      }),
      this.prisma.membership.count({ where })
    ])
    return {
      items: memberships.map(membership => ({
        id: membership.account.id, organizationId: membership.organizationId, email: membership.account.email,
        displayName: membership.account.displayName, status: membership.status, role: membership.role,
        createdAt: membership.account.createdAt, deviceCount: membership.account._count.devices,
        deviceGrantCount: membership.account._count.deviceGrants, lastSeenAt: membership.account.devices[0]?.lastSeenAt || null
      })),
      total, limit: query.limit, offset: query.offset
    }
  }

  async detail(organizationId: string, accountId: string): Promise<ManagedUserDetail> {
    const now = new Date()
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_accountId: { organizationId, accountId } },
      select: {
        organizationId: true, role: true, status: true,
        account: { select: {
          id: true, email: true, displayName: true, createdAt: true,
          devices: { where: { organizationId }, select: {
            id: true, name: true, installationId: true, platform: true, clientVersion: true,
            revokedAt: true, lastSeenAt: true, createdAt: true,
            grant: { select: {
              id: true, expiresAt: true, disabledAt: true, deletedAt: true, boundAt: true, deviceId: true,
              links: { orderBy: { issuanceOrder: 'desc' }, take: 1, select: {
                id: true, secretHint: true, expiresAt: true, revokedAt: true, consumedAt: true, createdAt: true, issuanceOrder: true
              } }
            } }
          } },
          deviceGrants: { where: { organizationId }, select: {
            id: true, expiresAt: true, disabledAt: true, deletedAt: true,
            boundAt: true, deviceId: true, createdAt: true, updatedAt: true,
            links: { orderBy: { issuanceOrder: 'desc' }, take: 1, select: {
              id: true, secretHint: true, expiresAt: true, revokedAt: true, consumedAt: true, createdAt: true, issuanceOrder: true
            } }
          } }
        } }
      }
    })
    if (!membership) throw new NotFoundException('Managed user not found')
    const { account } = membership
    return {
      id: account.id, organizationId: membership.organizationId, email: account.email, displayName: account.displayName,
      status: membership.status, role: membership.role, createdAt: account.createdAt, lastSeenAt: account.devices.reduce<Date | null>((latest, device) => !latest || (device.lastSeenAt && device.lastSeenAt > latest) ? device.lastSeenAt : latest, null),
      deviceCount: account.devices.length, deviceGrantCount: account.deviceGrants.length,
      devices: account.devices.map(device => {
        if (!device.grant) return { ...device, grant: null }
        const { links, ...grant } = device.grant
        return { ...device, grant: { ...grant, status: deriveDeviceGrantStatus(device.grant, now), currentLink: serializeCurrentLink(device.grant, now) } }
      }),
      deviceGrants: account.deviceGrants.map(grant => {
        const { links, ...summary } = grant
        return { ...summary, status: deriveDeviceGrantStatus(grant, now), currentLink: serializeCurrentLink(grant, now) }
      })
    }
  }

  async disable(organizationId: string, accountId: string): Promise<{ status: 'DISABLED' }> {
    await this.updateStatus(organizationId, accountId, 'DISABLED')
    return { status: 'DISABLED' }
  }

  async enable(organizationId: string, accountId: string): Promise<{ status: 'ACTIVE' }> {
    await this.updateStatus(organizationId, accountId, 'ACTIVE')
    return { status: 'ACTIVE' }
  }

  private async updateStatus(organizationId: string, accountId: string, status: 'ACTIVE' | 'DISABLED') {
    const updated = await this.prisma.membership.updateMany({
      where: { organizationId, accountId, role: Role.MEMBER }, data: { status }
    })
    if (updated.count === 1) return
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_accountId: { organizationId, accountId } }, select: { accountId: true }
    })
    if (!membership) throw new NotFoundException('Managed user not found')
    throw new ForbiddenException('Managed user cannot be updated')
  }
}
