import { Reflector } from '@nestjs/core'
import { describe, expect, it, vi } from 'vitest'
import { AuthGuard } from '../../packages/security/src/auth.js'
import { GatewayAuthGuard } from '../../packages/security/src/gateway-auth.js'
import { EmployeeKeysService } from '../../apps/api/src/employee-keys.service.js'
import { ProjectsService } from '../../apps/api/src/projects.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { createOpaqueToken, hashOpaqueToken, opaqueTokenHint } from '../../packages/security/src/tokens.js'
import { createOrganization, withTestDatabase } from '../integration/database.js'

const makeContext = (secret: string): any => {
  const request: any = { headers: { authorization: `Bearer ${secret}` } }
  return { switchToHttp: () => ({ getRequest: () => request }) }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('project-scoped gateway authentication (PostgreSQL)', () => {
  it('resolves the project from the employee API key and rejects inactive or mismatched projects', async () => {
    vi.stubEnv('EMPLOYEE_API_KEYS_ENABLED', 'true')
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const projects = new ProjectsService(db as PrismaService)
      const keys = new EmployeeKeysService(db as PrismaService)
      const region = await groups.create(actor, { name: '广东-市局区域', type: 'REGION' })
      await groups.addMember(actor, region.id, account.id)
      const project = await projects.create(actor, { regionId: region.id, code: 'GD-YX', name: '越秀' })
      await projects.addMember(actor, project.id, { accountId: account.id, role: 'CONTRIBUTOR' })
      const key = await keys.create(actor, account.id, {
        name: '广东-市局区域-越秀-员工', projectId: project.id
      })
      const guard = new GatewayAuthGuard(new AuthGuard(new Reflector(), db as PrismaService), db as PrismaService)
      const context = makeContext(key.secret)

      await guard.canActivate(context)
      expect(context.switchToHttp().getRequest().principal).toMatchObject({
        credentialType: 'API_KEY', groupId: region.id, projectId: project.id, sub: account.id
      })

      await db.project.update({ where: { id: project.id }, data: { status: 'SUSPENDED' } })
      await expect(guard.canActivate(makeContext(key.secret) as any)).rejects.toMatchObject({ status: 401 })
      await db.project.update({ where: { id: project.id }, data: { status: 'ACTIVE' } })
      await db.projectMember.deleteMany({ where: { projectId: project.id, accountId: account.id } })
      await expect(guard.canActivate(makeContext(key.secret) as any)).rejects.toMatchObject({ status: 401 })
    })
  })

  it('keeps legacy project-group keys compatible without a budget project', async () => {
    vi.stubEnv('EMPLOYEE_API_KEYS_ENABLED', 'true')
    await withTestDatabase(async db => {
      const { actor, account } = await createOrganization(db)
      const groups = new UsageGroupsService(db as PrismaService)
      const group = await groups.create(actor, { name: '历史项目组', type: 'PROJECT' })
      await groups.addMember(actor, group.id, account.id)
      const secret = `ucli_sk_${createOpaqueToken()}`
      const key = await db.employeeApiKey.create({ data: {
        organizationId: actor.organizationId, groupId: group.id, accountId: account.id,
        createdById: actor.sub, name: 'Legacy CLI', secretHash: hashOpaqueToken(secret),
        secretHint: opaqueTokenHint(secret)
      } })
      const guard = new GatewayAuthGuard(new AuthGuard(new Reflector(), db as PrismaService), db as PrismaService)
      const request: any = { headers: { authorization: `Bearer ${secret}` } }
      await guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) } as any)
      expect(request.principal).toMatchObject({ credentialType: 'API_KEY', groupId: group.id, projectId: null })
    })
  })
})
