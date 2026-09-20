import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { OrgUnitType, Prisma, type UsageGroup } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { AuthPrincipal } from '../../../packages/security/src/auth.js'
import { PageQueryDto } from './catalog.dto.js'
import { OrgUnitPageQueryDto, type CreateOrgUnitDto, type UpdateOrgUnitDto } from './org-units.dto.js'

@Injectable()
export class OrgUnitsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(actor: AuthPrincipal) {
    if (!['PLATFORM_ADMIN', 'ORG_ADMIN'].includes(actor.role)) throw new ForbiddenException('Administrator required')
  }

  private assertMutable(group: UsageGroup) {
    if (group.orgType === 'LEGACY_PROJECT') throw new ConflictException('Legacy project organizations are read-only')
  }

  private legacyType(kind: Exclude<OrgUnitType, 'LEGACY_PROJECT'>) {
    return kind === 'REGION' ? 'REGION' : 'DEPARTMENT'
  }

  private audit(db: Prisma.TransactionClient, actor: AuthPrincipal, id: string, action: string, metadata: Prisma.InputJsonObject = {}) {
    return db.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub,
      action: `org_unit.${action}`, resourceType: 'org_unit', resourceId: id, metadata } })
  }

  async create(actor: AuthPrincipal, input: CreateOrgUnitDto) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.create({ data: {
        organizationId: actor.organizationId, name: input.name, type: this.legacyType(input.kind),
        orgType: input.kind, description: input.description ?? ''
      } })
      if (input.kind !== 'REGION') {
        await db.project.create({ data: {
          organizationId: actor.organizationId, regionId: group.id, category: 'DEPARTMENT',
          code: `DEPT-${randomUUID().slice(0, 8).toUpperCase()}`, name: `${input.name}-部门预算`, description: ''
        } })
      }
      await this.audit(db, actor, group.id, 'create', { name: input.name, kind: input.kind })
      return db.usageGroup.findUniqueOrThrow({ where: { id: group.id } })
    })
  }

  async list(organizationId: string, query = new OrgUnitPageQueryDto()) {
    const where: Prisma.UsageGroupWhereInput = {
      organizationId,
      ...(query.kind ? { orgType: query.kind } : {}),
      ...(query.status === 'archived' ? { archivedAt: { not: null } } : query.status === 'all' ? {} :
        { archivedAt: null, enabled: query.status === 'active' }),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {})
    }
    const [groups, total] = await Promise.all([
      this.prisma.usageGroup.findMany({ where, skip: query.offset, take: query.limit,
        orderBy: [{ orgType: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        include: {
          _count: { select: {
            members: { where: { removedAt: null, isPrimary: true } },
            models: true,
            keys: { where: { revokedAt: null, disabledAt: null, deletedAt: null } }
          } },
          projects: { where: { category: 'DEPARTMENT', status: 'ACTIVE' },
            select: { id: true, code: true, name: true, status: true, category: true } }
        } }),
      this.prisma.usageGroup.count({ where })
    ])
    return { items: groups.map(group => {
      const departmentProject = group.projects.find(project => project.category === 'DEPARTMENT') ?? null
      return { ...group, projects: undefined, departmentProject,
        memberCount: group._count.members, modelCount: group._count.models, activeKeyCount: group._count.keys }
    }), total, limit: query.limit, offset: query.offset }
  }

  async detail(organizationId: string, id: string) {
    const group = await this.prisma.usageGroup.findFirst({ where: { id, organizationId },
      include: {
        _count: { select: {
          members: { where: { removedAt: null, isPrimary: true } },
          models: true,
          keys: { where: { revokedAt: null, disabledAt: null, deletedAt: null } },
          projects: { where: { status: 'ACTIVE' } }
        } },
        projects: { where: { status: 'ACTIVE' }, orderBy: [{ category: 'asc' }, { name: 'asc' }],
          select: { id: true, code: true, name: true, status: true, category: true,
            _count: { select: { members: true, employeeKeys: { where: { revokedAt: null, disabledAt: null, deletedAt: null } } } } } }
      } })
    if (!group) throw new NotFoundException('Organization unit not found')
    const { projects, _count, ...summary } = group
    return { ...summary, projects, memberCount: _count.members, modelCount: _count.models,
      activeKeyCount: _count.keys, activeProjectCount: _count.projects,
      departmentProject: projects.find(project => project.category === 'DEPARTMENT') ?? null }
  }

  update(actor: AuthPrincipal, id: string, input: UpdateOrgUnitDto) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.findFirst({ where: { id, organizationId: actor.organizationId } })
      if (!group) throw new NotFoundException('Organization unit not found')
      this.assertMutable(group)
      const updated = await db.usageGroup.update({ where: { id }, data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {})
      } })
      await this.audit(db, actor, id, 'update', { ...input })
      return updated
    })
  }

  addMember(actor: AuthPrincipal, id: string, accountId: string) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.findFirst({ where: { id, organizationId: actor.organizationId } })
      if (!group) throw new NotFoundException('Organization unit not found')
      this.assertMutable(group)
      const member = await db.membership.findFirst({ where: {
        organizationId: actor.organizationId, accountId, status: 'ACTIVE', account: { status: 'ACTIVE' }
      } })
      if (!member) throw new ForbiddenException('Active organization member required')
      const now = new Date()
      const currentPrimary = await db.groupMember.findFirst({ where: {
        organizationId: actor.organizationId, accountId, removedAt: null, isPrimary: true
      }, include: { group: { select: { id: true, orgType: true } } } })
      if (currentPrimary && ['FUNCTIONAL', 'EXECUTIVE'].includes(currentPrimary.group.orgType)) {
        await db.projectMember.deleteMany({ where: { organizationId: actor.organizationId,
          project: { regionId: currentPrimary.groupId, category: 'DEPARTMENT' }, accountId } })
      }
      await db.groupMember.updateMany({ where: {
        organizationId: actor.organizationId, accountId, removedAt: null, isPrimary: true
      }, data: { removedAt: now, isPrimary: false } })
      const updated = await db.groupMember.upsert({ where: { groupId_accountId: { groupId: id, accountId } },
        create: { organizationId: actor.organizationId, groupId: id, accountId, isPrimary: true, joinedAt: now },
        update: { removedAt: null, isPrimary: true, joinedAt: now },
        include: { membership: { select: { status: true, role: true,
          account: { select: { id: true, displayName: true, email: true, status: true } } } } } })
      if (group.orgType === 'FUNCTIONAL' || group.orgType === 'EXECUTIVE') {
        const departmentProject = await db.project.findFirst({ where: {
          organizationId: actor.organizationId, regionId: id, category: 'DEPARTMENT', status: 'ACTIVE'
        }, select: { id: true } })
        if (departmentProject) {
          await db.projectMember.upsert({ where: { projectId_accountId: {
            projectId: departmentProject.id, accountId
          } }, create: { organizationId: actor.organizationId, projectId: departmentProject.id, accountId },
            update: {} })
        }
      }
      await this.audit(db, actor, id, 'member_add', { accountId })
      return updated
    })
  }

  async removeMember(actor: AuthPrincipal, id: string, accountId: string) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.findFirst({ where: { id, organizationId: actor.organizationId } })
      if (!group) throw new NotFoundException('Organization unit not found')
      this.assertMutable(group)
      const existing = await db.groupMember.findFirst({ where: {
        organizationId: actor.organizationId, groupId: id, accountId, removedAt: null
      } })
      if (!existing) throw new NotFoundException('Organization member not found')
      const now = new Date()
      await db.groupMember.update({ where: { groupId_accountId: { groupId: id, accountId } },
        data: { removedAt: now, isPrimary: false } })
      let revokedDepartmentKeyCount = 0
      if (group.orgType === 'FUNCTIONAL' || group.orgType === 'EXECUTIVE') {
        const departmentProject = await db.project.findFirst({ where: {
          organizationId: actor.organizationId, regionId: id, category: 'DEPARTMENT'
        }, select: { id: true } })
        if (departmentProject) {
          await db.projectMember.deleteMany({ where: { organizationId: actor.organizationId,
            projectId: departmentProject.id, accountId } })
          revokedDepartmentKeyCount = await db.employeeApiKey.updateMany({ where: {
            organizationId: actor.organizationId, projectId: departmentProject.id, accountId, deletedAt: null
          }, data: { revokedAt: now } }).then(result => result.count)
        }
      }
      await this.audit(db, actor, id, 'member_remove', { accountId, revokedDepartmentKeyCount })
      return { accountId, revokedDepartmentKeyCount }
    })
  }

  async setHead(actor: AuthPrincipal, id: string, accountId: string) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.findFirst({ where: { id, organizationId: actor.organizationId } })
      if (!group) throw new NotFoundException('Organization unit not found')
      this.assertMutable(group)
      const member = await db.groupMember.findFirst({ where: {
        organizationId: actor.organizationId, groupId: id, accountId, removedAt: null
      } })
      if (!member) throw new NotFoundException('Organization member not found')
      await db.groupMember.updateMany({ where: { organizationId: actor.organizationId, groupId: id, removedAt: null },
        data: { role: 'MEMBER' } })
      await db.groupMember.update({ where: { groupId_accountId: { groupId: id, accountId } }, data: { role: 'LEADER' } })
      await this.audit(db, actor, id, 'set_head', { accountId })
      return { accountId, role: 'LEADER' as const }
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

  async projects(organizationId: string, id: string) {
    await this.detail(organizationId, id)
    return this.prisma.project.findMany({ where: { organizationId, regionId: id }, orderBy: [{ category: 'asc' }, { name: 'asc' }] })
  }

  async modelAccess(organizationId: string, id: string) {
    await this.detail(organizationId, id)
    return this.prisma.groupModelAccess.findMany({ where: { organizationId, groupId: id }, orderBy: { publicModelId: 'asc' },
      include: { publicModel: { select: { id: true, displayName: true, enabled: true, deletedAt: true } } } })
  }

  async replaceModels(actor: AuthPrincipal, id: string, publicModelIds: string[]) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const group = await db.usageGroup.findFirst({ where: { id, organizationId: actor.organizationId } })
      if (!group) throw new NotFoundException('Organization unit not found')
      this.assertMutable(group)
      await db.groupModelAccess.deleteMany({ where: { organizationId: actor.organizationId, groupId: id } })
      if (publicModelIds.length) {
        const models = await db.publicModel.findMany({ where: { id: { in: publicModelIds }, deletedAt: null }, select: { id: true } })
        if (models.length !== new Set(publicModelIds).size) throw new NotFoundException('One or more models not found')
        await db.groupModelAccess.createMany({ data: models.map(model => ({
          organizationId: actor.organizationId, groupId: id, publicModelId: model.id
        })) })
      }
      await this.audit(db, actor, id, 'replace_models', { count: publicModelIds.length })
      return this.modelAccess(actor.organizationId, id)
    })
  }
}
