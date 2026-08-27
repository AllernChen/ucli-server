import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createDeviceGrantLinkCredential, type DeviceGrantLinkCredential } from '../../../packages/security/src/device-grant-links.js'
import { loadMasterKey } from '../../../packages/security/src/master-key.js'

export interface CreateLinkInTransactionInput {
  organizationId: string
  actorId: string
  grantId: string
  expiresAt: Date | null
  action: 'create' | 'regenerate'
  credential: DeviceGrantLinkCredential
}

export interface CreatedDeviceGrantLink {
  id: string
  secret: string
  secretHint: string
  expiresAt: Date | null
  createdAt: Date
}

@Injectable()
export class DeviceGrantLinksService {
  private readonly masterKey = loadMasterKey()

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
        metadata: { deviceGrantId: input.grantId, expiresAt: input.expiresAt }
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
}
