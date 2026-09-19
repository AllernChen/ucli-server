import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signAccessToken } from '../../packages/security/src/auth.js'
import { AuthGuard } from '../../packages/security/src/auth.js'
import { DeviceGrantsService } from '../../apps/api/src/device-grants.service.js'
import { ProjectsService } from '../../apps/api/src/projects.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOrganization, withTestDatabase } from '../integration/database.js'

process.env.MASTER_KEY = Buffer.alloc(32).toString('base64')
process.env.PUBLIC_URL = 'http://localhost'

describe.skipIf(!process.env.TEST_DATABASE_URL)('project-scoped device grants (PostgreSQL)', () => {
  it('requires an active project when creating a region device grant', async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-123456'
    await withTestDatabase(async db => {
      const { actor, account, organization } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const grants = new DeviceGrantsService(db as PrismaService)
      const region = await groups.create(actor, { name: '广东-省厅区域', type: 'REGION' })
      await groups.addMember(actor, region.id, account.id)
      const project = await projects.create(actor, { regionId: region.id, code: 'GD-PROV', name: '省厅' })

      await expect(grants.create(organization.id, actor.sub, account.id, {
        groupId: region.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      })).rejects.toMatchObject({ status: 400 })

      const created = await grants.create(organization.id, actor.sub, account.id, {
        groupId: region.id, projectId: project.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      })
      const grant = await db.deviceGrant.findUniqueOrThrow({ where: { id: created.id } })
      expect(grant).toMatchObject({ groupId: region.id, projectId: project.id })

      await db.project.update({ where: { id: project.id }, data: { status: 'SUSPENDED' } })
      await expect(grants.create(organization.id, actor.sub, account.id, {
        groupId: region.id, projectId: project.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      })).rejects.toMatchObject({ status: 404 })
    })
  })

  it('resolves device project from live grant state and rejects suspended projects', async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-123456'
    await withTestDatabase(async db => {
      const { actor, account, organization } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const grants = new DeviceGrantsService(db as PrismaService)
      const region = await groups.create(actor, { name: '北京-GAB区域', type: 'REGION' })
      await groups.addMember(actor, region.id, account.id)
      const project = await projects.create(actor, { regionId: region.id, code: 'BJ-GAB', name: 'GAB' })
      const created = await grants.create(organization.id, actor.sub, account.id, {
        groupId: region.id, projectId: project.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      })
      const device = await db.device.create({ data: {
        organizationId: organization.id, accountId: account.id, name: 'CLI',
        installationId: randomUUID(), platform: 'windows', clientVersion: 'test',
        refreshTokenHash: randomUUID()
      } })
      await db.deviceGrant.update({ where: { id: created.id }, data: { deviceId: device.id, boundAt: new Date() } })

      const auth = new AuthGuard(new (await import('@nestjs/core')).Reflector(), db as PrismaService)
      const token = signAccessToken({
        sub: account.id, organizationId: organization.id, deviceId: device.id,
        groupId: region.id, projectId: '00000000-0000-4000-8000-000000000000',
        role: 'ORG_ADMIN', tokenVersion: 1
      })
      const principal = await auth.authenticateToken(token)
      expect(principal).toMatchObject({ groupId: region.id, projectId: project.id })

      await db.project.update({ where: { id: project.id }, data: { status: 'SUSPENDED' } })
      await expect(auth.authenticateToken(token)).rejects.toMatchObject({ status: 403 })
    })
  })

  it('keeps legacy non-region device grants compatible without a project', async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-123456'
    await withTestDatabase(async db => {
      const { actor, account, organization } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const grants = new DeviceGrantsService(db as PrismaService)
      const group = await groups.create(actor, { name: '历史项目组', type: 'PROJECT' })
      await groups.addMember(actor, group.id, account.id)
      const created = await grants.create(organization.id, actor.sub, account.id, {
        groupId: group.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      })
      const grant = await db.deviceGrant.findUniqueOrThrow({ where: { id: created.id } })
      expect(grant.projectId).toBeNull()
    })
  })
})
