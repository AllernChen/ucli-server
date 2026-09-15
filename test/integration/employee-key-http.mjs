// Build first, then: node --import tsx test/integration/employee-key-http.mjs
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Module, ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { createOrganization, testDatabaseUrl } from './database.ts'
import { PrismaService } from '../../dist/packages/database/src/prisma.service.js'
import { AuthGuard, signAccessToken } from '../../dist/packages/security/src/auth.js'
import { GatewayAuthGuard } from '../../dist/packages/security/src/gateway-auth.js'
import { encryptSecret } from '../../dist/packages/security/src/envelope-crypto.js'
import { ModelCatalogService } from '../../dist/packages/gateway-core/src/model-catalog.service.js'
import { RedisQuotaService } from '../../dist/packages/quota/src/redis-quota.js'
import { GroupBudgetService } from '../../dist/packages/quota/src/group-budget.service.js'
import { JsonSafeInterceptor } from '../../dist/packages/http/src/json.interceptor.js'
import { EmployeeKeysController } from '../../dist/apps/api/src/employee-keys.controller.js'
import { EmployeeKeysService } from '../../dist/apps/api/src/employee-keys.service.js'
import { UsageGroupsService } from '../../dist/apps/api/src/usage-groups.service.js'
import { AuthController } from '../../dist/apps/api/src/auth.controller.js'
import { AuthService } from '../../dist/apps/api/src/auth.service.js'
import { DeviceGrantsService } from '../../dist/apps/api/src/device-grants.service.js'
import { DeviceGrantLinksService } from '../../dist/apps/api/src/device-grant-links.service.js'
import { GatewayController } from '../../dist/apps/gateway/src/gateway.controller.js'
import { GatewayService } from '../../dist/apps/gateway/src/gateway.service.js'

process.env.JWT_SECRET = randomUUID()
process.env.MASTER_KEY = Buffer.alloc(32, 4).toString('base64')
delete process.env.EMPLOYEE_API_KEYS_ENABLED
const db = new PrismaService({ datasources: { db: { url: testDatabaseUrl() } } })
const received = []
const upstream = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  received.push({ headers: req.headers, body })
  if (body.stream) {
    res.setHeader('content-type', 'text/event-stream')
    res.end('data: {"choices":[{"delta":{"content":"OK"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n')
  } else {
    res.setHeader('content-type', 'application/json')
    const response = req.url === '/v1/chat/completions'
      ? { object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }
      : req.url === '/v1/responses'
        ? { object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 3, output_tokens: 2 } }
        : { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }
    res.end(JSON.stringify(response))
  }
})
class KeyTestModule {}
Module({ controllers: [AuthController, EmployeeKeysController, GatewayController], providers: [AuthService, DeviceGrantsService, DeviceGrantLinksService, AuthGuard, GatewayAuthGuard,
  EmployeeKeysService, UsageGroupsService, ModelCatalogService, GatewayService, GroupBudgetService, { provide: PrismaService, useValue: db },
  { provide: RedisQuotaService, useValue: { reserve() { throw new Error('This fixture has no Redis quota policies') } } }] })(KeyTestModule)
const app = await NestFactory.create(KeyTestModule, { logger: false })
app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
app.useGlobalInterceptors(new JsonSafeInterceptor())
try {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  await app.listen(0, '127.0.0.1')
  const base = await app.getUrl()
  const a = await createOrganization(db)
  const adminToken = signAccessToken(a.actor)
  const employee = await db.account.create({ data: { email: `${randomUUID()}@example.invalid`, displayName: 'Employee' } })
  await db.membership.create({ data: { organizationId: a.organization.id, accountId: employee.id, role: 'MEMBER' } })
  const employeeToken = signAccessToken({ ...a.actor, sub: employee.id, role: 'MEMBER', tokenVersion: employee.tokenVersion })
  const groups = app.get(UsageGroupsService)
  const group = await groups.create(a.actor, { name: 'Key HTTP', type: 'PROJECT' })
  const otherGroup = await groups.create(a.actor, { name: 'Other', type: 'PROJECT' })
  await groups.addMember(a.actor, group.id, employee.id)
  await groups.addMember(a.actor, otherGroup.id, employee.id)
  const encrypted = encryptSecret('upstream-only-test-secret', Buffer.alloc(32, 4))
  const channel = await db.channel.create({ data: { name: 'Local HTTP mock', provider: 'test', protocol: 'OPENAI', maxRetries: 0,
    baseUrl: `http://127.0.0.1:${upstream.address().port}`, keys: { create: { ciphertext: encrypted.ciphertext, iv: encrypted.iv, tag: encrypted.tag, suffix: 'test' } } } })
  const models = []
  for (const protocol of ['OPENAI_CHAT', 'OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES']) {
    models.push(await db.publicModel.create({ data: { id: randomUUID(), displayName: protocol, enabled: true, contextSize: 8192,
      channelModels: { create: { channelId: channel.id, upstreamModel: protocol, protocol, health: 'HEALTHY' } },
      prices: { create: { inputPerMillion: '1', outputPerMillion: '2', validFrom: new Date(0) } } } }))
  }
  await groups.replaceModels(a.actor, group.id, models.map(model => model.id))
  async function request(path, method = 'GET', body, token = adminToken, headers = {}) {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text()
    return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text }
  }
  const createPath = `/api/v1/admin/users/${employee.id}/api-keys`
  const created = await request(createPath, 'POST', { name: 'CLI', groupId: group.id })
  assert.equal(created.status, 201)
  assert.equal(created.headers.get('cache-control'), 'no-store')
  const key = created.body
  const me = await request('/api/v1/auth/me', 'GET', undefined, employeeToken)
  assert.equal(me.status, 200)
  assert.equal(me.headers.get('cache-control'), 'no-store')
  assert.deepEqual(me.body, { id: employee.id, displayName: 'Employee', organizationId: a.organization.id, role: 'MEMBER' })
  assert.equal((await request('/api/v1/auth/me', 'GET', undefined, key.secret)).status, 401)
  assert.deepEqual((await request('/api/v1/me/usage-groups', 'GET', undefined, employeeToken)).body.map(g => g.id).sort(), [group.id, otherGroup.id].sort())
  assert.equal((await request(`/api/v1/admin/users/${a.account.id}/usage-groups`, 'GET', undefined, employeeToken)).status, 401)
  assert.match(key.secret, /^ucli_sk_/)
  assert.equal((await request('/v1/models', 'GET', undefined, key.secret)).status, 403) // default off
  process.env.EMPLOYEE_API_KEYS_ENABLED = 'true'
  assert.equal((await request('/v1/models', 'GET', undefined, 'ucli_sk_unknown')).status, 401)
  assert.equal((await request('/v1/models', 'GET', undefined, 'not-a-jwt')).status, 401)
  const directory = await request('/v1/models', 'GET', undefined, key.secret)
  assert.equal(directory.headers.get('cache-control'), 'no-store')
  assert.deepEqual(directory.body.data.map(model => model.id).sort(), models.map(model => model.id).sort())
  const anthropic = await request('/anthropic/v1/models?limit=1000', 'GET', undefined, '', { 'x-api-key': key.secret })
  assert.equal(anthropic.status, 200)
  assert.equal(anthropic.headers.get('cache-control'), 'no-store')
  assert.deepEqual(anthropic.body.data.map(model => model.id), [models[2].id])
  assert.equal((await request('/v1/models', 'GET', undefined, key.secret, { 'x-api-key': key.secret })).status, 200)
  assert.equal((await request('/v1/models', 'GET', undefined, key.secret, { 'x-api-key': 'different' })).status, 401)
  assert.equal((await request(`/v1/models?api_key=${key.secret}`, 'GET', undefined, '')).status, 401)
  assert.equal((await request('/v1/models', 'GET', undefined, adminToken)).status, 401)
  assert.equal((await request(createPath, 'GET', undefined, key.secret)).status, 401)
  assert.equal((await request('/api/v1/me/api-keys', 'GET', undefined, key.secret)).status, 401)
  assert.equal((await request(createPath, 'POST', { name: 'Forbidden', groupId: group.id }, employeeToken)).status, 401)
  const mine = await request('/api/v1/me/api-keys', 'GET', undefined, employeeToken)
  assert.deepEqual(mine.body.items.map(item => item.id), [key.id])
  assert.ok(!JSON.stringify(mine).includes(key.secret))
  assert.ok(!JSON.stringify(mine).includes('secretHash'))
  const device = await db.device.create({ data: { organizationId: a.organization.id, accountId: employee.id,
    name: 'Device', refreshTokenHash: randomUUID() } })
  await db.deviceGrant.create({ data: { organizationId: a.organization.id, accountId: employee.id, createdById: a.account.id,
    deviceId: device.id, groupId: group.id } })
  const deviceToken = signAccessToken({ ...a.actor, sub: employee.id, role: 'MEMBER', deviceId: device.id, tokenVersion: employee.tokenVersion })
  assert.equal((await request('/api/v1/me/api-keys', 'GET', undefined, deviceToken)).status, 403)
  assert.equal((await request('/v1/models', 'GET', undefined, deviceToken)).status, 200)
  assert.equal((await request('/anthropic/v1/models', 'GET', undefined, deviceToken)).status, 200)
  assert.equal((await request(`/api/v1/admin/employee-api-keys/${key.id}`, 'PATCH', { groupId: otherGroup.id })).status, 400)
  const otherKey = (await request(createPath, 'POST', { name: 'Other', groupId: otherGroup.id })).body
  assert.deepEqual((await request('/v1/models', 'GET', undefined, otherKey.secret)).body.data, [])
  assert.equal((await request('/v1/chat/completions', 'POST', { model: models[0].id, messages: [] }, otherKey.secret)).status, 403)
  assert.equal(received.length, 0)
  const validChat = { model: models[0].id, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 16 }
  assert.equal((await request('/v1/chat/completions', 'POST', validChat, key.secret)).status, 429)
  assert.equal(received.length, 0)
  await app.get(GroupBudgetService).adjust(a.actor, group.id, { operationId: randomUUID(), scope: 'CURRENT', limitCny: '1', unlimited: false, reason: 'Local HTTP test budget' })
  for (const [index, path, stream] of [[0, '/v1/chat/completions', false], [1, '/v1/responses', false],
    [2, '/anthropic/v1/messages', false], [0, '/v1/chat/completions', true]]) {
    const body = { model: models[index].id, stream, ...(index === 1 ? { input: 'Hi', max_output_tokens: 16 }
      : { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 16 }) }
    const response = await request(path, 'POST', body, key.secret, { 'anthropic-beta': 'test-beta', 'anthropic-version': '2023-06-01' })
    assert.equal(response.status, 200)
    const requestId = response.headers.get('x-ucli-request-id')
    let log
    for (let attempt = 0; attempt < 100; attempt++) {
      log = await db.usageLog.findUnique({ where: { requestId } })
      if (log) break
      await delay(20)
    }
    assert.ok(log, 'Request must persist a usage log')
    assert.equal(log.credentialType, 'API_KEY')
    assert.equal(log.deviceId, null)
    assert.equal(log.apiKeyId, key.id)
    assert.equal(log.accountId, employee.id)
    assert.equal(log.groupId, group.id)
    assert.equal(log.costUsd.toFixed(8), '0.00000700')
    const sent = received.at(-1)
    assert.ok(!JSON.stringify(sent).includes(key.secret))
    if (index === 2) {
      assert.equal(sent.headers['x-api-key'], 'upstream-only-test-secret')
      assert.equal(sent.headers.authorization, undefined)
      assert.equal(sent.headers['anthropic-beta'], 'test-beta')
    } else assert.equal(sent.headers.authorization, 'Bearer upstream-only-test-secret')
  }
  await request(`/api/v1/admin/employee-api-keys/${key.id}/disable`, 'POST')
  assert.equal((await request('/v1/models', 'GET', undefined, key.secret)).status, 401)
  await request(`/api/v1/admin/employee-api-keys/${key.id}/enable`, 'POST')
  assert.equal((await request('/v1/models', 'GET', undefined, key.secret)).status, 200)
  assert.equal((await request(`/api/v1/me/api-keys/${key.id}/revoke`, 'POST', undefined, adminToken)).status, 404)
  await request(`/api/v1/me/api-keys/${key.id}/revoke`, 'POST', undefined, employeeToken)
  assert.equal((await request('/v1/models', 'GET', undefined, key.secret)).status, 401)
  assert.equal((await request(`/api/v1/admin/employee-api-keys/${key.id}/enable`, 'POST')).status, 409)
  await request(`/api/v1/admin/employee-api-keys/${otherKey.id}`, 'DELETE')
  assert.equal((await request('/v1/models', 'GET', undefined, otherKey.secret)).status, 401)
  console.log('Employee Key HTTP passed: default-off, admin/me isolation, protocol discovery, mock upstream calls/streaming, log attribution and revocation.')
} finally {
  await app.close()
  await new Promise(resolve => upstream.close(resolve))
  await db.$disconnect()
}
