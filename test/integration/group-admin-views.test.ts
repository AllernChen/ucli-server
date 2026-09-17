import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { withTestDatabase, createOrganization } from './database.js'
import { AuthService } from '../../apps/api/src/auth.service.js'
import { EmployeeKeysService } from '../../apps/api/src/employee-keys.service.js'
import { UsageGroupsService } from '../../apps/api/src/usage-groups.service.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('management view identity and options', () => {
  it('only exposes verified web identity and the selected employee’s active groups', async () => withTestDatabase(async db => {
    const a = await createOrganization(db); const b = await createOrganization(db)
    const auth = new AuthService(db as PrismaService)
    expect(await auth.me(a.actor)).toEqual({ id: a.account.id, displayName: 'Test employee', email: a.account.email, status: a.account.status,
      organizationId: a.organization.id, organizationName: a.organization.name, role: 'ORG_ADMIN' })
    await expect(auth.me({ ...a.actor, deviceId: randomUUID() })).rejects.toMatchObject({ status: 403 })
    const groups = new UsageGroupsService(db as PrismaService)
    const group = await groups.create(a.actor, { name: 'A', type: 'PROJECT' })
    await groups.addMember(a.actor, group.id, a.account.id)
    const keys = new EmployeeKeysService(db as PrismaService)
    expect((await keys.groups(a.actor)).map(g => g.id)).toEqual([group.id])
    expect(await keys.groups(b.actor)).toEqual([])
    await expect(keys.groups({ ...a.actor, role: 'MEMBER' }, b.account.id)).rejects.toMatchObject({ status: 403 })
    await groups.setEnabled(a.actor, group.id, false)
    expect(await keys.groups(a.actor)).toEqual([])
  }))

  it('previews member policy restrictions without exposing supplier secrets or other tenants', async () => withTestDatabase(async db => {
    const a = await createOrganization(db); const b = await createOrganization(db)
    const service = new UsageGroupsService(db as PrismaService)
    const group = await service.create(a.actor, { name: 'Preview', type: 'PROJECT' })
    await service.addMember(a.actor, group.id, a.account.id)
    const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Policy model', enabled: true, contextSize: 4096,
      policies: { create: { organizationId: b.organization.id } } } })
    await service.replaceModels(a.actor, group.id, [model.id])
    const preview = await service.modelOptions(a.organization.id, group.id, a.account.id)
    expect(preview.find(m => m.id === model.id)).toMatchObject({ selected: true, allowed: false, reasons: expect.arrayContaining(['现有模型策略不允许该员工使用']) })
    expect(JSON.stringify(preview)).not.toMatch(/ciphertext|secretHash|baseUrl/)
    await expect(service.modelOptions(b.organization.id, group.id, a.account.id)).rejects.toMatchObject({ status: 404 })
    await expect(service.modelOptions(a.organization.id, group.id, b.account.id)).rejects.toMatchObject({ status: 403 })
  }))
})
