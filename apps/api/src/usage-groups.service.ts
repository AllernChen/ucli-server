import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, type UsageGroup } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { AuthPrincipal } from '../../../packages/security/src/auth.js'
import { lockUsageGroup } from '../../../packages/security/src/group-access.js'
import { PageQueryDto } from './catalog.dto.js'
import { UsageGroupPageQueryDto, type CreateUsageGroupDto, type UpdateUsageGroupDto } from './usage-groups.dto.js'

const retryRevocation = Symbol('retryRevocation')

@Injectable()
export class UsageGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(actor: AuthPrincipal) {
    if (!['PLATFORM_ADMIN', 'ORG_ADMIN'].includes(actor.role)) throw new ForbiddenException('Administrator required')
  }

  private audit(db: Prisma.TransactionClient, actor: AuthPrincipal, id: string, action: string, metadata: Prisma.InputJsonObject = {}) {
    return db.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub,
      action: `usage_group.${action}`, resourceType: 'usage_group', resourceId: id, metadata } })
  }

  private async mutate<T>(actor: AuthPrincipal, id: string, action: string,
    change: (db: Prisma.TransactionClient, group: UsageGroup) => Promise<T>, metadata: Prisma.InputJsonObject = {}) {
    this.assertAdmin(actor)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(async db => {
          const group = await lockUsageGroup(db, actor.organizationId, id)
          if (group.archivedAt) throw new ConflictException('Archived groups cannot be modified')
          const result = await change(db, group)
          await this.audit(db, actor, id, action, metadata)
          return result
        }, { timeout: 15_000 })
      } catch (error) {
        const conflict = error === retryRevocation || (error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' || (error.code === 'P2010' && error.meta?.code === '40P01')))
        if (!conflict) throw error
      }
    }
    throw new ConflictException('Concurrent credential change; retry the operation')
  }

  async create(actor: AuthPrincipal, input: CreateUsageGroupDto) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.create({ data: { organizationId: actor.organizationId,
        name: input.name, type: input.type, description: input.description,
        budgetMode: input.type === 'DEPARTMENT' ? 'MONTHLY' : 'TOTAL' } })
      await this.audit(db, actor, group.id, 'create', { name: input.name, type: input.type })
      return group
    })
  }

  async list(organizationId: string, query = new UsageGroupPageQueryDto()) {
    const where: Prisma.UsageGroupWhereInput = { organizationId, type: query.type,
      ...(query.status === 'archived' ? { archivedAt: { not: null } } : query.status === 'all' ? {} :
        { archivedAt: null, enabled: query.status === 'active' }),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}) }
    const [items, total] = await Promise.all([
      this.prisma.usageGroup.findMany({ where, skip: query.offset, take: query.limit, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: { _count: { select: { members: { where: { removedAt: null } }, models: true } } } }),
      this.prisma.usageGroup.count({ where })
    ])
    return { items, total, limit: query.limit, offset: query.offset }
  }

  async detail(organizationId: string, id: string) {
    const group = await this.prisma.usageGroup.findFirst({ where: { id, organizationId } })
    if (!group) throw new NotFoundException('Usage group not found')
    return group
  }

  update(actor: AuthPrincipal, id: string, input: UpdateUsageGroupDto) {
    return this.mutate(actor, id, 'update', db => db.usageGroup.update({ where: { id },
      data: { name: input.name, description: input.description } }), { ...input })
  }

  setEnabled(actor: AuthPrincipal, id: string, enabled: boolean) {
    return this.mutate(actor, id, enabled ? 'enable' : 'disable', db => db.usageGroup.update({ where: { id }, data: { enabled } }))
  }

  archive(actor: AuthPrincipal, id: string) {
    return this.mutate(actor, id, 'archive', async db => {
      const now = new Date()
      await this.revokeCredentials(db, actor.organizationId, id, now)
      return db.usageGroup.update({ where: { id }, data: { enabled: false, archivedAt: now } })
    })
  }

  async members(organizationId: string, id: string, query = new PageQueryDto()) {
    await this.detail(organizationId, id)
    const where = { organizationId, groupId: id, removedAt: null }
    const [items, total] = await Promise.all([
      this.prisma.groupMember.findMany({ where, skip: query.offset, take: query.limit, orderBy: { accountId: 'asc' },
        include: { membership: { select: { status: true, role: true,
          account: { select: { id: true, displayName: true, email: true, status: true } } } } } }),
      this.prisma.groupMember.count({ where })
    ])
    return { items, total, limit: query.limit, offset: query.offset }
  }

  addMember(actor: AuthPrincipal, id: string, accountId: string) {
    return this.mutate(actor, id, 'add_member', async db => {
      const member = await db.membership.findFirst({ where: { organizationId: actor.organizationId, accountId,
        status: 'ACTIVE', account: { status: 'ACTIVE' } } })
      if (!member) throw new ForbiddenException('Active organization member required')
      return db.groupMember.upsert({ where: { groupId_accountId: { groupId: id, accountId } },
        create: { organizationId: actor.organizationId, groupId: id, accountId }, update: { removedAt: null, joinedAt: new Date() } })
    }, { accountId })
  }

  removeMember(actor: AuthPrincipal, id: string, accountId: string) {
    return this.mutate(actor, id, 'remove_member', async db => {
      const now = new Date()
      const result = await db.groupMember.updateMany({ where: { organizationId: actor.organizationId, groupId: id, accountId, removedAt: null },
        data: { removedAt: now } })
      if (!result.count) throw new NotFoundException('Group member not found')
      await this.revokeCredentials(db, actor.organizationId, id, now, accountId)
      return { accountId, removedAt: now }
    }, { accountId })
  }

  async models(organizationId: string, id: string) {
    await this.detail(organizationId, id)
    return this.prisma.groupModelAccess.findMany({ where: { organizationId, groupId: id }, orderBy: { publicModelId: 'asc' },
      include: { publicModel: { select: { id: true, displayName: true, enabled: true, deletedAt: true } } } })
  }

  replaceModels(actor: AuthPrincipal, id: string, publicModelIds: string[]) {
    return this.mutate(actor, id, 'replace_models', async db => {
      const ids = [...new Set(publicModelIds)]
      const count = await db.publicModel.count({ where: { id: { in: ids }, deletedAt: null } })
      if (count !== ids.length) throw new BadRequestException('Unknown or archived model')
      await db.groupModelAccess.deleteMany({ where: { organizationId: actor.organizationId, groupId: id } })
      await db.groupModelAccess.createMany({ data: ids.map(publicModelId => ({ organizationId: actor.organizationId, groupId: id, publicModelId })) })
      return { publicModelIds: ids }
    }, { publicModelIds })
  }

  private async revokeCredentials(db: Prisma.TransactionClient, organizationId: string, groupId: string, now: Date, accountId?: string) {
    await db.employeeApiKey.updateMany({ where: { organizationId, groupId, accountId, revokedAt: null }, data: { revokedAt: now } })
    const grants = await db.deviceGrant.findMany({ where: { organizationId, groupId, accountId, deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true } })
    for (const { id } of grants) {
      // Same link-before-grant lock order as redemption/regeneration, including consumed retry links.
      const links = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM device_grant_links WHERE device_grant_id = ${id}::uuid ORDER BY issuance_order DESC FOR UPDATE
      `)
      await db.$queryRaw(Prisma.sql`SELECT id FROM device_grants WHERE id = ${id}::uuid FOR UPDATE`)
      const current = await db.deviceGrantLink.findMany({ where: { deviceGrantId: id }, select: { id: true } })
      if (current.some(link => !links.some(locked => locked.id === link.id))) throw retryRevocation
      const grant = await db.deviceGrant.findUniqueOrThrow({ where: { id }, select: { deviceId: true } })
      await db.deviceGrantLink.updateMany({ where: { deviceGrantId: id, revokedAt: null }, data: { revokedAt: now, secretEncrypted: Prisma.DbNull } })
      await db.deviceGrant.update({ where: { id }, data: { deletedAt: now } })
      if (grant.deviceId) await db.device.update({ where: { id: grant.deviceId }, data: { revokedAt: now } })
    }
  }
}
