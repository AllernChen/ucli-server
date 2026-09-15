import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

export interface GroupIdentity { organizationId: string; accountId: string; groupId: string }

export async function assertDeviceGroup(db: Prisma.TransactionClient, identity: Omit<GroupIdentity, 'groupId'> & { groupId?: string | null }, required: boolean) {
  if (identity.groupId) return assertActiveGroupMember(db, { ...identity, groupId: identity.groupId })
  if (required) throw new ForbiddenException({ code: 'group_required', message: 'Device must be assigned to a usage group' })
}

export async function assertActiveGroupMember(db: Prisma.TransactionClient, identity: GroupIdentity) {
  const member = await db.groupMember.findFirst({ where: {
    organizationId: identity.organizationId, accountId: identity.accountId, groupId: identity.groupId, removedAt: null,
    group: { enabled: true, archivedAt: null, organization: { enabled: true } },
    membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } }
  }, include: { group: { include: { models: true } } } })
  if (!member) throw new ForbiddenException({ code: 'group_access_denied', message: 'Group membership is inactive or unavailable' })
  return member
}

// Mutations/credential issuance lock the group before changing membership.
export async function lockUsageGroup(db: Prisma.TransactionClient, organizationId: string, groupId: string) {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM usage_groups WHERE id = ${groupId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE
  `)
  if (!rows.length) throw new NotFoundException('Usage group not found')
  return db.usageGroup.findUniqueOrThrow({ where: { id: groupId } })
}
