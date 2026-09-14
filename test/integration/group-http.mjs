// Run after npm run build: node --import tsx test/integration/group-http.mjs
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Module, ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { createOrganization, testDatabaseUrl } from './database.ts'
import { PrismaService } from '../../dist/packages/database/src/prisma.service.js'
import { AuthGuard, signAccessToken } from '../../dist/packages/security/src/auth.js'
import { GatewayAuthGuard } from '../../dist/packages/security/src/gateway-auth.js'
import { ModelCatalogService } from '../../dist/packages/gateway-core/src/model-catalog.service.js'
import { RedisQuotaService } from '../../dist/packages/quota/src/redis-quota.js'
import { JsonSafeInterceptor } from '../../dist/packages/http/src/json.interceptor.js'
import { UsageGroupsController } from '../../dist/apps/api/src/usage-groups.controller.js'
import { UsageGroupsService } from '../../dist/apps/api/src/usage-groups.service.js'
import { ClientController } from '../../dist/apps/api/src/client.controller.js'
import { GatewayController } from '../../dist/apps/gateway/src/gateway.controller.js'
import { GatewayService } from '../../dist/apps/gateway/src/gateway.service.js'

const db = new PrismaService({ datasources: { db: { url: testDatabaseUrl() } } })
process.env.JWT_SECRET = randomUUID()
class GroupTestModule {}
Module({
  controllers: [UsageGroupsController, GatewayController, ClientController],
  providers: [AuthGuard, GatewayAuthGuard, UsageGroupsService, ModelCatalogService, GatewayService,
    { provide: PrismaService, useValue: db },
    { provide: RedisQuotaService, useValue: { reserve() { throw new Error('Denied requests must not reserve quota') } } }]
})(GroupTestModule)
const app = await NestFactory.create(GroupTestModule, { logger: false })
app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
app.useGlobalInterceptors(new JsonSafeInterceptor())
try {
  await app.listen(0, '127.0.0.1')
  const base = await app.getUrl()
  const a = await createOrganization(db)
  const b = await createOrganization(db)
  const adminToken = signAccessToken(a.actor)
  const otherToken = signAccessToken(b.actor)
  const prefix = '/api/v1/admin/usage-groups'
  async function request(path, method = 'GET', body, token = adminToken) {
    const response = await fetch(base + path, { method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  assert.equal((await request(prefix, 'GET', undefined, '')).status, 401)
  assert.equal((await request(prefix, 'POST', { name: ' ', type: 'PROJECT' })).status, 400)
  assert.equal((await request(prefix, 'POST', { name: 'Test', type: 'PROJECT', organizationId: b.organization.id })).status, 400)
  const created = await request(prefix, 'POST', { name: 'HTTP test', type: 'PROJECT' })
  assert.equal(created.status, 201)
  const id = created.body.id
  assert.equal((await request(`${prefix}/${id}`, 'GET', undefined, otherToken)).status, 404)
  await db.membership.update({ where: { organizationId_accountId: { organizationId: b.organization.id, accountId: b.account.id } }, data: { role: 'MEMBER' } })
  assert.equal((await request(prefix, 'GET', undefined, signAccessToken({ ...b.actor, role: 'MEMBER' }))).status, 401)
  assert.equal((await request(`${prefix}/${id}/members`, 'POST', { accountId: b.account.id })).status, 403)
  assert.equal((await request(`${prefix}/${id}/members`, 'POST', { accountId: a.account.id })).status, 201)
  assert.equal((await request(`${prefix}/${id}/models`, 'PUT', { publicModelIds: ['same', 'same'] })).status, 400)
  assert.equal((await request(`${prefix}/${id}/models`, 'PUT', { publicModelIds: [] })).status, 200)

  const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Group HTTP model', enabled: true, contextSize: 4096,
    channelModels: { create: { upstreamModel: 'test', protocol: 'OPENAI_CHAT',
      channel: { create: { name: 'Test', provider: 'test', protocol: 'OPENAI', baseUrl: 'https://example.invalid',
        keys: { create: { ciphertext: 'test', iv: 'test', tag: 'test', suffix: 'test' } } } } } } } })
  const device = await db.device.create({ data: { organizationId: a.organization.id, accountId: a.account.id,
    name: 'HTTP device', refreshTokenHash: randomUUID() } })
  await db.deviceGrant.create({ data: { organizationId: a.organization.id, accountId: a.account.id, createdById: a.account.id,
    deviceId: device.id, groupId: id } })
  const deviceToken = signAccessToken({ ...a.actor, deviceId: device.id, groupId: 'client-cannot-override-this' })
  const denied = await request('/v1/chat/completions', 'POST', { model: model.id, messages: [] }, deviceToken)
  assert.equal(denied.status, 403)
  assert.equal(denied.body.code, 'model_access_denied')
  assert.deepEqual((await request('/v1/models', 'GET', undefined, deviceToken)).body.data, [])
  assert.deepEqual((await request('/api/v1/client/bootstrap', 'GET', undefined, deviceToken)).body.models, [])
  assert.equal((await request(`${prefix}/${id}/models`, 'PUT', { publicModelIds: [model.id] })).status, 200)
  const directory = await request('/v1/models', 'GET', undefined, deviceToken)
  assert.equal(directory.headers.get('cache-control'), 'no-store')
  assert.deepEqual(directory.body.data.map(item => item.id), [model.id])
  assert.deepEqual((await request('/api/v1/client/bootstrap', 'GET', undefined, deviceToken)).body.models.map(item => item.id), [model.id])
  // Existing model policies still constrain an explicit group allowlist.
  await db.modelAccessPolicy.create({ data: { publicModelId: model.id, organizationId: b.organization.id } })
  assert.deepEqual((await request('/v1/models', 'GET', undefined, deviceToken)).body.data, [])
  await request(`${prefix}/${id}/disable`, 'POST')
  assert.equal((await request('/v1/models', 'GET', undefined, deviceToken)).status, 403)
  await request(`${prefix}/${id}/enable`, 'POST')
  await request(`${prefix}/${id}/members/${a.account.id}`, 'DELETE')
  assert.equal((await request('/v1/models', 'GET', undefined, deviceToken)).status, 401)
  await request(`${prefix}/${id}/members`, 'POST', { accountId: a.account.id })
  assert.equal((await request('/v1/models', 'GET', undefined, deviceToken)).status, 401)
  await request(`${prefix}/${id}`, 'DELETE')
  assert.equal((await request(`${prefix}/${id}/enable`, 'POST')).status, 409)
  console.log('Group HTTP smoke passed: admin validation, tenant isolation, live directory/relay/bootstrap permissions, permanent revocation.')
} finally {
  await app.close()
  await db.$disconnect()
}
