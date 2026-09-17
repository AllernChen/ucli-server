import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, type EmployeeApiKey } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { AuthPrincipal } from '../../../packages/security/src/auth.js'
import { assertActiveGroupMember, lockUsageGroup } from '../../../packages/security/src/group-access.js'
import { createOpaqueToken, hashOpaqueToken, opaqueTokenHint } from '../../../packages/security/src/tokens.js'
import { PageQueryDto } from './catalog.dto.js'
import { EmployeeKeyQueryDto, type CreateEmployeeKeyDto, type UpdateEmployeeKeyDto } from './employee-keys.dto.js'

const keySummary = Prisma.validator<Prisma.EmployeeApiKeySelect>()({
  id: true, organizationId: true, accountId: true, groupId: true, name: true, secretHint: true,
  createdAt: true, createdById: true, expiresAt: true, disabledAt: true, revokedAt: true, deletedAt: true, lastUsedAt: true
})

const keyListSummary = Prisma.validator<Prisma.EmployeeApiKeySelect>()({
  ...keySummary,
  membership: { select: { account: { select: { id: true, displayName: true, email: true } } } },
  group: { select: { id: true, name: true } },
  createdBy: { select: { id: true, displayName: true } }
})

function expiry(value: string | null | undefined): Date | null | undefined {
  if (value === null || value === undefined) return value
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date <= new Date()) throw new BadRequestException('expiresAt must be in the future')
  return date
}

@Injectable()
export class EmployeeKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async groups(actor: AuthPrincipal, accountId?: string) {
    if (accountId !== undefined) this.assertAdmin(actor)
    else this.assertWebSession(actor)
    return this.prisma.usageGroup.findMany({ where: { organizationId: actor.organizationId, enabled: true, archivedAt: null,
      members: { some: { accountId: accountId ?? actor.sub, removedAt: null,
        membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } } } } },
      select: { id: true, name: true, type: true }, orderBy: { name: 'asc' } })
  }

  private assertAdmin(actor: AuthPrincipal) {
    if (!['PLATFORM_ADMIN', 'ORG_ADMIN'].includes(actor.role)) throw new ForbiddenException('Administrator required')
  }

  private assertWebSession(actor: AuthPrincipal) {
    if (actor.deviceId) throw new ForbiddenException('Web login required')
  }

  private audit(db: Prisma.TransactionClient, actor: AuthPrincipal, key: { id: string; accountId: string; groupId: string }, action: string) {
    return db.auditLog.create({ data: { actorAccountId: actor.sub, organizationId: actor.organizationId,
      action: `employee_api_key.${action}`, resourceType: 'employee_api_key', resourceId: key.id,
      metadata: { accountId: key.accountId, groupId: key.groupId } } })
  }

  async create(actor: AuthPrincipal, accountId: string, input: CreateEmployeeKeyDto) {
    this.assertAdmin(actor)
    const expiresAt = expiry(input.expiresAt)
    const secret = `ucli_sk_${createOpaqueToken()}`
    const key = await this.prisma.$transaction(async db => {
      await lockUsageGroup(db, actor.organizationId, input.groupId)
      await assertActiveGroupMember(db, { organizationId: actor.organizationId, accountId, groupId: input.groupId })
      const created = await db.employeeApiKey.create({ data: { organizationId: actor.organizationId, accountId,
        groupId: input.groupId, name: input.name, createdById: actor.sub, expiresAt,
        secretHash: hashOpaqueToken(secret), secretHint: opaqueTokenHint(secret) }, select: keySummary })
      await this.audit(db, actor, created, 'create')
      return created
    })
    return { ...key, secret }
  }

  async list(actor: AuthPrincipal, accountId: string, query: PageQueryDto = new PageQueryDto()) {
    this.assertAdmin(actor)
    const member = await this.prisma.membership.findUnique({ where: { organizationId_accountId: { organizationId: actor.organizationId, accountId } } })
    if (!member) throw new NotFoundException('User not found')
    return this.listFor(actor.organizationId, accountId, query as EmployeeKeyQueryDto, false)
  }

  async listMine(actor: AuthPrincipal, query: PageQueryDto = new PageQueryDto()) {
    this.assertWebSession(actor)
    const keyQuery = query as EmployeeKeyQueryDto
    if (keyQuery.accountId && keyQuery.accountId !== actor.sub) throw new ForbiddenException('Personal keys belong to the authenticated account')
    return this.listFor(actor.organizationId, actor.sub, keyQuery, false)
  }

  listManaged(actor: AuthPrincipal, query: EmployeeKeyQueryDto = new EmployeeKeyQueryDto()) {
    this.assertAdmin(actor)
    return this.listFor(actor.organizationId, query.accountId, query, true)
  }

  private async listFor(organizationId: string, accountId: string | undefined, query: EmployeeKeyQueryDto, managed: boolean) {
    const where = this.listWhere(organizationId, accountId, query, managed, new Date())
    const [items, total, filterGroups] = await Promise.all([
      this.prisma.employeeApiKey.findMany({ where, select: keyListSummary, skip: query.offset, take: query.limit, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
      this.prisma.employeeApiKey.count({ where }),
      !managed && accountId ? this.prisma.usageGroup.findMany({ where: { organizationId, keys: { some: { organizationId, accountId, deletedAt: null } } },
        select: { id: true, name: true }, orderBy: { name: 'asc' } }) : Promise.resolve([])
    ])
    return { items: items.map(item => {
      const { membership, group, createdBy, ...key } = item
      return { ...key, account: membership.account, group, createdBy }
    }), total, offset: query.offset, limit: query.limit, ...(!managed ? { filterGroups } : {}) }
  }

  private listWhere(organizationId: string, accountId: string | undefined, query: EmployeeKeyQueryDto, managed: boolean, now: Date): Prisma.EmployeeApiKeyWhereInput {
    const filters: Prisma.EmployeeApiKeyWhereInput[] = [{ organizationId, deletedAt: null }]
    if (accountId) filters.push({ accountId })
    if (query.groupId) filters.push({ groupId: query.groupId })
    if (query.status) filters.push({
      revoked: { revokedAt: { not: null } },
      disabled: { revokedAt: null, disabledAt: { not: null } },
      expired: { revokedAt: null, disabledAt: null, expiresAt: { lte: now } },
      active: { revokedAt: null, disabledAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
    }[query.status])
    if (query.q) {
      const contains = { contains: query.q, mode: 'insensitive' as const }
      filters.push({ OR: [
        { name: contains }, { secretHint: contains },
        ...(managed ? [{ membership: { account: { OR: [{ displayName: contains }, { email: contains }] } } }] : [])
      ] })
    }
    return filters.length === 1 ? filters[0] : { AND: filters }
  }

  private async mutate(actor: AuthPrincipal, id: string, action: string,
    change: (key: EmployeeApiKey, db: Prisma.TransactionClient) => Promise<Prisma.EmployeeApiKeyUpdateManyMutationInput>, ownOnly = false) {
    if (ownOnly) this.assertWebSession(actor)
    else this.assertAdmin(actor)
    const where = { id, organizationId: actor.organizationId, ...(ownOnly ? { accountId: actor.sub } : {}) }
    const initial = await this.prisma.employeeApiKey.findFirst({ where, select: { groupId: true } })
    if (!initial) throw new NotFoundException('Employee API key not found')
    return this.prisma.$transaction(async db => {
      await lockUsageGroup(db, actor.organizationId, initial.groupId)
      const key = await db.employeeApiKey.findFirstOrThrow({ where })
      const data = await change(key, db)
      await db.employeeApiKey.updateMany({ where, data })
      await this.audit(db, actor, key, action)
      return db.employeeApiKey.findFirstOrThrow({ where, select: keySummary })
    })
  }

  private assertMutable(key: EmployeeApiKey) {
    if (key.revokedAt || key.deletedAt) throw new ConflictException('Revoked or deleted keys cannot be restored or edited')
  }

  update(actor: AuthPrincipal, id: string, input: UpdateEmployeeKeyDto) {
    const expiresAt = expiry(input.expiresAt)
    return this.mutate(actor, id, 'update', async key => {
      this.assertMutable(key)
      return { name: input.name, expiresAt }
    })
  }

  setEnabled(actor: AuthPrincipal, id: string, enabled: boolean) {
    return this.mutate(actor, id, enabled ? 'enable' : 'disable', async (key, db) => {
      this.assertMutable(key)
      if (enabled) await assertActiveGroupMember(db, key)
      return { disabledAt: enabled ? null : new Date() }
    })
  }

  revoke(actor: AuthPrincipal, id: string, ownOnly = false) {
    return this.mutate(actor, id, 'revoke', async key => ({ revokedAt: key.revokedAt ?? new Date() }), ownOnly)
  }

  delete(actor: AuthPrincipal, id: string) {
    return this.mutate(actor, id, 'delete', async key => ({ revokedAt: key.revokedAt ?? new Date(), deletedAt: key.deletedAt ?? new Date() }))
  }
}
