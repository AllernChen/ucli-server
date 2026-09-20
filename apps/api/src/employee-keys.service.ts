import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import argon2 from 'argon2'
import { Prisma, type EmployeeApiKey } from '@prisma/client'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import type { AuthPrincipal } from '../../../packages/security/src/auth.js'
import { assertActiveGroupMember, lockUsageGroup } from '../../../packages/security/src/group-access.js'
import { decryptSecret, encryptSecret } from '../../../packages/security/src/envelope-crypto.js'
import { loadMasterKey } from '../../../packages/security/src/master-key.js'
import { createOpaqueToken, hashOpaqueToken, opaqueTokenHint } from '../../../packages/security/src/tokens.js'
import { PageQueryDto } from './catalog.dto.js'
import { EmployeeKeyQueryDto, type CreateEmployeeKeyDto, type UpdateEmployeeKeyDto } from './employee-keys.dto.js'
import { readProjectBudgets } from '../../../packages/quota/src/project-budget-read.js'
import Decimal from 'decimal.js'

const keySummary = Prisma.validator<Prisma.EmployeeApiKeySelect>()({
  id: true, organizationId: true, accountId: true, groupId: true, projectId: true,
  name: true, secretHint: true, secretCiphertext: true, secretIv: true, secretTag: true,
  project: { select: { id: true, code: true, name: true } },
  createdAt: true, createdById: true, expiresAt: true, disabledAt: true, revokedAt: true, deletedAt: true, lastUsedAt: true
})

const keyListSummary = Prisma.validator<Prisma.EmployeeApiKeySelect>()({
  ...keySummary,
  membership: { select: { account: { select: { id: true, displayName: true, email: true } } } },
  group: { select: { id: true, name: true } },
  project: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, displayName: true } }
})

const revealAttempts = new Map<string, { count: number; resetAt: number }>()

function expiry(value: string | null | undefined): Date | null | undefined {
  if (value === null || value === undefined) return value
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date <= new Date()) throw new BadRequestException('expiresAt must be in the future')
  return date
}

function publicSummary<T extends { secretCiphertext: string | null; secretIv: string | null; secretTag: string | null }>({
  secretCiphertext, secretIv, secretTag, ...summary
}: T) {
  return { ...summary, secretRecoverable: Boolean(secretCiphertext && secretIv && secretTag) }
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

  private audit(db: Prisma.TransactionClient, actor: AuthPrincipal,
    key: { id: string; accountId: string; groupId: string; projectId?: string | null }, action: string) {
    return db.auditLog.create({ data: { actorAccountId: actor.sub, organizationId: actor.organizationId,
      action: `employee_api_key.${action}`, resourceType: 'employee_api_key', resourceId: key.id,
      metadata: { accountId: key.accountId, groupId: key.groupId, projectId: key.projectId ?? null } } })
  }

  async projectOptions(actor: AuthPrincipal, accountId: string | undefined, regionId: string) {
    if (accountId !== undefined) this.assertAdmin(actor)
    else this.assertWebSession(actor)
    return this.prisma.project.findMany({
      where: {
        organizationId: actor.organizationId, regionId, status: 'ACTIVE',
        region: {
          orgType: { in: ['REGION', 'FUNCTIONAL', 'EXECUTIVE'] }, enabled: true, archivedAt: null,
          members: { some: { accountId: accountId ?? actor.sub, removedAt: null,
            membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } } } }
        }
      },
      select: { id: true, code: true, name: true, regionId: true },
      orderBy: { name: 'asc' }
    })
  }

  async create(actor: AuthPrincipal, accountId: string, input: CreateEmployeeKeyDto) {
    this.assertAdmin(actor)
    if ('groupId' in input) throw new BadRequestException('projectId is required; groupId is no longer accepted')
    if (!input.projectId) throw new BadRequestException('projectId is required')
    const expiresAt = expiry(input.expiresAt)
    const secret = `ucli_sk_${createOpaqueToken()}`
    const encrypted = encryptSecret(secret, loadMasterKey())
    const key = await this.prisma.$transaction(async db => {
      const locked = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM projects
        WHERE id = ${input.projectId}::uuid AND organization_id = ${actor.organizationId}::uuid
        FOR UPDATE
      `)
      if (!locked.length) throw new NotFoundException('Active project not found')
      const project = await db.project.findFirst({
        where: {
          id: input.projectId, organizationId: actor.organizationId, status: 'ACTIVE',
          region: { enabled: true, archivedAt: null, organization: { enabled: true }, orgType: { in: ['REGION', 'FUNCTIONAL', 'EXECUTIVE'] } }
        },
        select: { id: true, regionId: true, category: true }
      })
      if (!project) throw new NotFoundException('Active project not found')
      const projectMember = await db.projectMember.findFirst({ where: {
        projectId: project.id, accountId, role: { not: 'VIEWER' },
        membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } }
      }, select: { projectId: true, accountId: true } })
      if (!projectMember) throw new ForbiddenException('Active project member required')
      await lockUsageGroup(db, actor.organizationId, project.regionId)
      const created = await db.employeeApiKey.create({ data: { organizationId: actor.organizationId, accountId,
        groupId: project.regionId, projectId: project.id, name: input.name, createdById: actor.sub, expiresAt,
        secretHash: hashOpaqueToken(secret), secretHint: opaqueTokenHint(secret),
        secretCiphertext: encrypted.ciphertext, secretIv: encrypted.iv, secretTag: encrypted.tag }, select: keySummary })
      await this.audit(db, actor, created, 'create')
      return created
    })
    return { ...publicSummary(key), secret }
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
    const keyIds = items.map(item => item.id)
    const projectIds = [...new Set(items.flatMap(item => item.projectId ? [item.projectId] : []))].filter((value): value is string => Boolean(value))
    const [usageRows, budgets] = await Promise.all([
      keyIds.length && this.prisma.usageLog?.groupBy ? this.prisma.usageLog.groupBy({ by: ['apiKeyId'], where: {
        organizationId, apiKeyId: { in: keyIds }
      }, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, costUsd: true } }) : Promise.resolve([]),
      projectIds.length ? readProjectBudgets(this.prisma, organizationId, projectIds) : Promise.resolve(new Map())
    ])
    const usageByKey = new Map(usageRows.filter(row => row.apiKeyId).map(row => [row.apiKeyId, {
      requests: row._count._all,
      totalTokens: ((row._sum.inputTokens ?? 0n) + (row._sum.outputTokens ?? 0n)).toString(),
      costCny: new Decimal(row._sum.costUsd ?? 0).toFixed(8)
    }]))
    const projectCost = new Map<string, Decimal>()
    for (const item of items) {
      if (!item.projectId) continue
      const cost = new Decimal(usageByKey.get(item.id)?.costCny || 0)
      projectCost.set(item.projectId, (projectCost.get(item.projectId) ?? new Decimal(0)).plus(cost))
    }
    return { items: items.map(item => {
      const { membership, group, project, createdBy, ...key } = item
      const usage = usageByKey.get(item.id)
      const keyCost = new Decimal(usage?.costCny || 0)
      const projectId = item.projectId
      const budget = projectId ? budgets.get(projectId) : undefined
      const projectKeyCost = projectId ? projectCost.get(projectId) ?? new Decimal(0) : new Decimal(0)
      return { ...publicSummary(key), account: membership.account, group, project, createdBy,
        usage: { requests: usage?.requests ?? 0, totalTokens: usage?.totalTokens ?? '0',
          costCny: keyCost.toFixed(8), lastUsedAt: item.lastUsedAt },
        budget: budget ? {
          limitCny: budget.limitCny, spentCny: budget.spentCny, reservedCny: budget.reservedCny,
          availableCny: budget.availableCny, unlimited: budget.unlimited,
          keyCostSharePercent: budget.unlimited || new Decimal(budget.limitCny).isZero() ? null :
            Number(keyCost.dividedBy(budget.limitCny).times(100).toFixed(2)),
          projectUsageSharePercent: projectKeyCost.greaterThan(0) ?
            Number(keyCost.dividedBy(projectKeyCost).times(100).toFixed(2)) : null
        } : null }
    }), total, offset: query.offset, limit: query.limit, ...(!managed ? { filterGroups } : {}) }
  }

  async reveal(actor: AuthPrincipal, id: string, input: { password: string }) {
    this.assertAdmin(actor)
    this.assertWebSession(actor)
    const account = await this.prisma.account.findUnique({ where: { id: actor.sub },
      select: { status: true, passwordHash: true } })
    if (!account || account.status !== 'ACTIVE' || !account.passwordHash ||
        !await argon2.verify(account.passwordHash, input.password)) {
      throw new UnauthorizedException('Administrator password is incorrect')
    }
    const key = await this.prisma.employeeApiKey.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null },
      select: { id: true, accountId: true, groupId: true, projectId: true, name: true, secretHint: true,
        secretCiphertext: true, secretIv: true, secretTag: true } })
    if (!key) throw new NotFoundException('Employee API key not found')
    if (!key.secretCiphertext || !key.secretIv || !key.secretTag) {
      throw new ConflictException('Legacy key has no recoverable secret; create a replacement key')
    }
    let secret: string
    try {
      secret = decryptSecret({ algorithm: 'aes-256-gcm', ciphertext: key.secretCiphertext, iv: key.secretIv, tag: key.secretTag }, loadMasterKey())
    } catch {
      throw new ConflictException('Stored key cannot be decrypted with the current MASTER_KEY')
    }
    await this.prisma.$transaction(db => this.audit(db, actor, key, 'reveal'))
    return { id: key.id, secret }
  }

  async revealOwn(actor: AuthPrincipal, id: string, input: { password: string }) {
    this.assertWebSession(actor)
    const throttleKey = `${actor.organizationId}:${actor.sub}`
    const attempts = revealAttempts.get(throttleKey)
    if (attempts && attempts.count >= 5 && attempts.resetAt > Date.now()) {
      throw new UnauthorizedException('Too many reveal attempts; try again later')
    }
    const account = await this.prisma.account.findUnique({ where: { id: actor.sub },
      select: { status: true, passwordHash: true } })
    if (!account || account.status !== 'ACTIVE' || !account.passwordHash ||
        !await argon2.verify(account.passwordHash, input.password)) {
      const next = attempts && attempts.resetAt > Date.now() ? attempts : { count: 0, resetAt: Date.now() + 300_000 }
      revealAttempts.set(throttleKey, { count: next.count + 1, resetAt: next.resetAt })
      throw new UnauthorizedException('Current password is incorrect')
    }
    revealAttempts.delete(throttleKey)
    const key = await this.prisma.employeeApiKey.findFirst({ where: {
      id, organizationId: actor.organizationId, accountId: actor.sub, deletedAt: null
    }, select: { id: true, name: true, secretCiphertext: true, secretIv: true, secretTag: true } })
    if (!key) throw new NotFoundException('Employee API key not found')
    if (!key.secretCiphertext || !key.secretIv || !key.secretTag) {
      throw new ConflictException('This legacy key has no recoverable secret; issue a replacement key')
    }
    let secret: string
    try {
      secret = decryptSecret({ algorithm: 'aes-256-gcm', ciphertext: key.secretCiphertext, iv: key.secretIv, tag: key.secretTag }, loadMasterKey())
    } catch {
      throw new ConflictException('Stored key cannot be decrypted with the current MASTER_KEY')
    }
    await this.prisma.$transaction(db => db.auditLog.create({ data: {
      organizationId: actor.organizationId, actorAccountId: actor.sub, action: 'employee_api_key.self_reveal',
      resourceType: 'employee_api_key', resourceId: key.id, metadata: { name: key.name }
    } }))
    return { id: key.id, secret }
  }

  private listWhere(organizationId: string, accountId: string | undefined, query: EmployeeKeyQueryDto, managed: boolean, now: Date): Prisma.EmployeeApiKeyWhereInput {
    const filters: Prisma.EmployeeApiKeyWhereInput[] = [{ organizationId, deletedAt: null }]
    if (accountId) filters.push({ accountId })
    if (query.groupId) filters.push({ groupId: query.groupId })
    if (query.projectId) filters.push({ projectId: query.projectId })
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
      return publicSummary(await db.employeeApiKey.findFirstOrThrow({ where, select: keySummary }))
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
      if (enabled && key.projectId) {
        const projectMember = await db.projectMember.findFirst({ where: {
          projectId: key.projectId, accountId: key.accountId, role: { not: 'VIEWER' },
          membership: { status: 'ACTIVE', account: { status: 'ACTIVE' } }
        }, select: { projectId: true, accountId: true } })
        if (!projectMember) throw new ForbiddenException('Active project member required')
      } else if (enabled) await assertActiveGroupMember(db, key)
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
