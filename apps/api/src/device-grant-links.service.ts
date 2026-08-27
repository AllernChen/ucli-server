import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { deriveDeviceGrantStatus } from '../../../packages/security/src/device-grants.js'
import { createDeviceGrantLinkCredential, deriveDeviceGrantLinkStatus, revealDeviceGrantLinkSecret, type DeviceGrantLinkCredential } from '../../../packages/security/src/device-grant-links.js'
import { loadMasterKey } from '../../../packages/security/src/master-key.js'
import { requirePublicUrl } from '../../../packages/security/src/public-url.js'
import type { CreateDeviceGrantLinkDto } from './device-grants.dto.js'

export interface CreateLinkInTransactionInput {
  organizationId: string
  actorId: string
  grantId: string
  expiresAt: Date | null
  action: 'create' | 'regenerate'
  credential: DeviceGrantLinkCredential
  previousLinkId?: string | null
}

export interface CreatedDeviceGrantLink {
  id: string
  secret: string
  secretHint: string
  expiresAt: Date | null
  createdAt: Date
}

function parseLinkExpiry(value: CreateDeviceGrantLinkDto['expiresAt'], now: Date): Date | null {
  if (value === undefined) return new Date(now.getTime() + 7 * 24 * 60 * 60_000)
  if (value === null) return null
  const expiresAt = new Date(value)
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new BadRequestException('expiresAt must be in the future')
  }
  return expiresAt
}

function serializeLink(link: Omit<CreatedDeviceGrantLink, 'secret'>, status = deriveDeviceGrantLinkStatus({ consumedAt: null, revokedAt: null, expiresAt: link.expiresAt })) {
  return { id: link.id, secretHint: link.secretHint, status, expiresAt: link.expiresAt, createdAt: link.createdAt }
}

function linkNotFound(): NotFoundException {
  return new NotFoundException('Device grant link not found')
}

@Injectable()
export class DeviceGrantLinksService {
  private readonly masterKey = loadMasterKey()

  constructor(private readonly prisma?: PrismaService) {}

  prepareCredential(): DeviceGrantLinkCredential {
    return createDeviceGrantLinkCredential(this.masterKey)
  }

  async createInTransaction(
    transaction: Prisma.TransactionClient,
    input: CreateLinkInTransactionInput
  ): Promise<CreatedDeviceGrantLink> {
    const link = await transaction.deviceGrantLink.create({ data: {
      deviceGrantId: input.grantId,
      createdById: input.actorId,
      expiresAt: input.expiresAt,
      secretHash: input.credential.secretHash,
      secretHint: input.credential.secretHint,
      secretEncrypted: input.credential.secretEncrypted as unknown as Prisma.InputJsonValue
    } })
    if (transaction.auditLog) {
      await transaction.auditLog.create({ data: {
        actorAccountId: input.actorId,
        organizationId: input.organizationId,
        action: `device_grant_link.${input.action}`,
        resourceType: 'device_grant_link',
        resourceId: link.id,
        metadata: {
          deviceGrantId: input.grantId, previousLinkId: input.previousLinkId ?? null, newLinkId: link.id,
          secretHint: input.credential.secretHint, status: 'AVAILABLE', expiresAt: input.expiresAt
        }
      } })
    }
    return {
      id: link.id,
      secret: input.credential.secret,
      secretHint: input.credential.secretHint,
      expiresAt: link.expiresAt,
      createdAt: link.createdAt
    }
  }

  async viewCurrent(organizationId: string, actorId: string, grantId: string) {
    if (!this.prisma) throw new Error('PrismaService is required to view device grant links')
    const grant = await this.prisma.deviceGrant.findFirst({ where: { id: grantId, organizationId }, select: { id: true } })
    if (!grant) throw linkNotFound()
    const link = await this.prisma.deviceGrantLink.findFirst({
      where: { deviceGrantId: grant.id }, orderBy: { createdAt: 'desc' }
    })
    if (!link || !link.secretEncrypted) throw linkNotFound()
    const status = deriveDeviceGrantLinkStatus(link)
    if (status !== 'AVAILABLE' && status !== 'EXPIRED') throw linkNotFound()
    const secret = revealDeviceGrantLinkSecret(link.secretEncrypted as any, this.masterKey)
    const origin = requirePublicUrl()
    await this.prisma.auditLog.create({ data: {
      actorAccountId: actorId, organizationId, action: 'device_grant_link.view', resourceType: 'device_grant_link', resourceId: link.id,
      metadata: { deviceGrantId: grant.id, secretHint: link.secretHint, status, expiresAt: link.expiresAt }
    } })
    return {
      currentLink: serializeLink(link, status),
      connectionUrl: `${origin}/connect#link=${encodeURIComponent(secret)}`
    }
  }

  async regenerate(organizationId: string, actorId: string, grantId: string, input: CreateDeviceGrantLinkDto) {
    if (!this.prisma) throw new Error('PrismaService is required to regenerate device grant links')
    const replacement = await this.prisma.$transaction(async transaction => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "device_grants"
        WHERE "id" = ${grantId}::uuid AND "organization_id" = ${organizationId}::uuid
        FOR UPDATE
      `)
      if (!locked[0]) throw linkNotFound()
      const grant = await transaction.deviceGrant.findFirst({
        where: { id: grantId, organizationId },
        select: { id: true, deviceId: true, disabledAt: true, deletedAt: true, expiresAt: true }
      })
      if (!grant) throw linkNotFound()
      const status = deriveDeviceGrantStatus(grant)
      if (status !== 'AVAILABLE') throw new BadRequestException({ code: `grant_${status.toLowerCase()}` })
      const previous = await transaction.deviceGrantLink.findFirst({
        where: { deviceGrantId: grant.id, revokedAt: null, consumedAt: null }, orderBy: { createdAt: 'desc' }
      })
      const now = new Date()
      const expiresAt = parseLinkExpiry(input.expiresAt, now)
      await transaction.deviceGrantLink.updateMany({
        where: { deviceGrantId: grant.id, revokedAt: null, consumedAt: null },
        data: { revokedAt: now, secretEncrypted: Prisma.DbNull }
      })
      const link = await this.createInTransaction(transaction, {
        organizationId, actorId, grantId: grant.id, expiresAt, action: 'regenerate', previousLinkId: previous?.id ?? null,
        credential: this.prepareCredential()
      })
      return link
    })
    const origin = requirePublicUrl()
    return {
      currentLink: serializeLink(replacement),
      connectionUrl: `${origin}/connect#link=${encodeURIComponent(replacement.secret)}`
    }
  }
}
