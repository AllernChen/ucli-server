import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, type Project } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { AuthPrincipal } from '../../../packages/security/src/auth.js'
import { CreateProjectDto, ProjectPageQueryDto, UpdateProjectDto, type ProjectMemberRole } from './projects.dto.js'

const projectSelect = Prisma.validator<Prisma.ProjectSelect>()({
  id: true, organizationId: true, regionId: true, code: true, name: true, description: true,
  status: true, sourceGroupId: true, budgetMode: true, budgetTimezone: true, createdAt: true, updatedAt: true,
  region: { select: { id: true, name: true } },
  members: { orderBy: { accountId: 'asc' }, include: { membership: { select: {
    status: true, role: true, account: { select: { id: true, displayName: true, email: true, status: true } }
  } } } }
})

type ProjectWithRelations = Prisma.ProjectGetPayload<{ select: typeof projectSelect }>

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(actor: AuthPrincipal) {
    if (!['PLATFORM_ADMIN', 'ORG_ADMIN'].includes(actor.role)) throw new ForbiddenException('Administrator required')
  }

  private async region(db: Prisma.TransactionClient, organizationId: string, regionId: string) {
    const regions = await db.$queryRaw<Array<{ id: string, name: string }>>(Prisma.sql`
      SELECT id, name FROM usage_groups
      WHERE id = ${regionId}::uuid
        AND organization_id = ${organizationId}::uuid
        AND type = 'REGION'
        AND enabled = true
        AND archived_at IS NULL
      FOR UPDATE
    `)
    const region = regions[0]
    if (!region) throw new NotFoundException('Region usage group not found')
    return region
  }

  private audit(db: Prisma.TransactionClient, actor: AuthPrincipal, id: string, action: string,
    metadata: Prisma.InputJsonObject = {}) {
    return db.auditLog.create({ data: { organizationId: actor.organizationId, actorAccountId: actor.sub,
      action: `project.${action}`, resourceType: 'project', resourceId: id, metadata } })
  }

  private visibleRegions(actor: AuthPrincipal): Prisma.UsageGroupWhereInput | undefined {
    if (actor.role === 'PLATFORM_ADMIN' || actor.role === 'ORG_ADMIN') return undefined
    return { members: { some: { accountId: actor.sub, removedAt: null,
      group: { enabled: true, archivedAt: null, organization: { enabled: true } },
      membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } } } } }
  }

  async list(actor: AuthPrincipal, query: Partial<ProjectPageQueryDto> = new ProjectPageQueryDto()) {
    const page = Object.assign(new ProjectPageQueryDto(), query)
    const where: Prisma.ProjectWhereInput = {
      organizationId: actor.organizationId,
      region: this.visibleRegions(actor),
      status: page.status ?? 'ACTIVE',
      ...(page.regionId ? { regionId: page.regionId } : {}),
      ...(page.q ? { OR: [
        { code: { contains: page.q, mode: 'insensitive' } },
        { name: { contains: page.q, mode: 'insensitive' } }
      ] } : {})
    }
    const [items, total] = await Promise.all([
      this.prisma.project.findMany({ where, skip: page.offset, take: page.limit,
        orderBy: [{ name: 'asc' }, { id: 'asc' }], select: projectSelect }),
      this.prisma.project.count({ where })
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  async create(actor: AuthPrincipal, input: CreateProjectDto) {
    this.assertAdmin(actor)
    try {
      return await this.prisma.$transaction(async db => {
        await this.region(db, actor.organizationId, input.regionId)
        const project = await db.project.create({ data: { organizationId: actor.organizationId,
          regionId: input.regionId, code: input.code, name: input.name, description: input.description },
          select: projectSelect })
        await this.audit(db, actor, project.id, 'create', { regionId: input.regionId, code: input.code, name: input.name })
        return project
      }, { timeout: 15_000 })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Project code or name already exists in the target region')
      }
      throw error
    }
  }

  async detail(actor: AuthPrincipal, id: string): Promise<ProjectWithRelations> {
    const project = await this.prisma.project.findFirst({ where: {
      id, organizationId: actor.organizationId,
      ...(actor.role === 'MEMBER' ? { status: 'ACTIVE', region: this.visibleRegions(actor) } : {})
    }, select: projectSelect })
    if (!project) throw new NotFoundException('Project not found')
    return project
  }

  private async mutate<T>(actor: AuthPrincipal, id: string, action: string,
    change: (db: Prisma.TransactionClient, project: Project) => Promise<T>, metadata: Prisma.InputJsonObject = {}) {
    this.assertAdmin(actor)
    return this.prisma.$transaction(async db => {
      const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM projects WHERE id = ${id}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE
      `)
      if (!rows.length) throw new NotFoundException('Project not found')
      const project = await db.project.findUniqueOrThrow({ where: { id } })
      const result = await change(db, project)
      await this.audit(db, actor, id, action, metadata)
      return result
    }, { timeout: 15_000 })
  }

  update(actor: AuthPrincipal, id: string, input: UpdateProjectDto) {
    return this.mutate(actor, id, 'update', async (db, project) => {
      if (project.status === 'ARCHIVED') throw new ConflictException('Archived projects cannot be modified')
      try {
        return await db.project.update({ where: { id }, data: { name: input.name, description: input.description },
          select: projectSelect })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException('Project name already exists in the target region')
        }
        throw error
      }
    }, { ...input })
  }

  async setStatus(actor: AuthPrincipal, id: string, status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED') {
    return this.mutate(actor, id, status === 'ARCHIVED' ? 'archive' : status === 'ACTIVE' ? 'enable' : 'disable',
      async (db, project) => {
        if (project.status === 'ARCHIVED') throw new ConflictException('Archived projects cannot be modified')
        if (status === 'ARCHIVED') {
          const unsettled = await db.projectBudgetEntry.count({ where: { organizationId: actor.organizationId,
            projectId: id, status: { in: ['RESERVED', 'RECONCILIATION_REQUIRED'] } } })
          if (unsettled) throw new ConflictException('Project budget has unsettled or reserved entries')
        }
        return db.project.update({ where: { id }, data: { status }, select: projectSelect })
      }, { status })
  }

  async members(actor: AuthPrincipal, id: string) {
    const project = await this.detail(actor, id)
    return { items: project.members, total: project.members.length }
  }

  addMember(actor: AuthPrincipal, id: string, input: { accountId: string; role: ProjectMemberRole }) {
    return this.mutate(actor, id, 'add_member', async (db, project) => {
      if (project.status === 'ARCHIVED') throw new ConflictException('Archived projects cannot be modified')
      const regionMember = await db.groupMember.findFirst({ where: {
        organizationId: actor.organizationId, groupId: project.regionId, accountId: input.accountId, removedAt: null,
        group: { enabled: true, archivedAt: null, organization: { enabled: true } },
        membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } }
      } })
      if (!regionMember) throw new ForbiddenException('Active region member required')
      return db.projectMember.upsert({ where: { projectId_accountId: { projectId: id, accountId: input.accountId } },
        create: { organizationId: actor.organizationId, projectId: id, accountId: input.accountId, role: input.role },
        update: { role: input.role }, include: { membership: { select: {
          status: true, role: true, account: { select: { id: true, displayName: true, email: true, status: true } }
        } } } })
    }, { ...input })
  }

  setMemberRole(actor: AuthPrincipal, id: string, accountId: string, role: ProjectMemberRole) {
    return this.mutate(actor, id, 'set_member_role', async (db, project) => {
      if (project.status === 'ARCHIVED') throw new ConflictException('Archived projects cannot be modified')
      const result = await db.projectMember.updateMany({ where: { organizationId: actor.organizationId,
        projectId: id, accountId }, data: { role } })
      if (!result.count) throw new NotFoundException('Project member not found')
      return { accountId, role }
    }, { accountId, role })
  }

  removeMember(actor: AuthPrincipal, id: string, accountId: string) {
    return this.mutate(actor, id, 'remove_member', async (db, project) => {
      if (project.status === 'ARCHIVED') throw new ConflictException('Archived projects cannot be modified')
      const result = await db.projectMember.deleteMany({ where: { organizationId: actor.organizationId,
        projectId: id, accountId } })
      if (!result.count) throw new NotFoundException('Project member not found')
      return { accountId }
    }, { accountId })
  }
}
