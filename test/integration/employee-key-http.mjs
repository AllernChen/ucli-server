// Build first, then: node --import tsx test/integration/employee-key-http.mjs
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Module, ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import argon2 from 'argon2'
import { createOrganization, testDatabaseUrl } from './database.ts'
import { PrismaService } from '../../dist/packages/database/src/prisma.service.js'
import { AuthGuard, signAccessToken } from '../../dist/packages/security/src/auth.js'
import { GatewayAuthGuard } from '../../dist/packages/security/src/gateway-auth.js'
import { encryptSecret } from '../../dist/packages/security/src/envelope-crypto.js'
import { ModelCatalogService } from '../../dist/packages/gateway-core/src/model-catalog.service.js'
import { RedisQuotaService } from '../../dist/packages/quota/src/redis-quota.js'
import { GroupBudgetService } from '../../dist/packages/quota/src/group-budget.service.js'
import { ProjectBudgetService } from '../../dist/packages/quota/src/project-budget.service.js'
import { JsonSafeInterceptor } from '../../dist/packages/http/src/json.interceptor.js'
import { EmployeeKeysController } from '../../dist/apps/api/src/employee-keys.controller.js'
import { EmployeeKeysService } from '../../dist/apps/api/src/employee-keys.service.js'
import { UsageGroupsService } from '../../dist/apps/api/src/usage-groups.service.js'
import { AuthController } from '../../dist/apps/api/src/auth.controller.js'
import { AuthService } from '../../dist/apps/api/src/auth.service.js'
import { DeviceGrantsService } from '../../dist/apps/api/src/device-grants.service.js'
import { DeviceGrantLinksService } from '../../dist/apps/api/src/device-grant-links.service.js'
import { DeviceGrantsController } from '../../dist/apps/api/src/device-grants.controller.js'
import { UsageGroupsController } from '../../dist/apps/api/src/usage-groups.controller.js'
import { ProjectsController } from '../../dist/apps/api/src/projects.controller.js'
import { ProjectsService } from '../../dist/apps/api/src/projects.service.js'
import { UsersController } from '../../dist/apps/api/src/users.controller.js'
import { UsersService } from '../../dist/apps/api/src/users.service.js'
import { UsageController } from '../../dist/apps/api/src/usage.controller.js'
import { AnalyticsController } from '../../dist/apps/api/src/analytics.controller.js'
import { AnalyticsService } from '../../dist/apps/api/src/analytics.service.js'
import Redis from 'ioredis'
import { GatewayController } from '../../dist/apps/gateway/src/gateway.controller.js'
import { GatewayService } from '../../dist/apps/gateway/src/gateway.service.js'

process.env.JWT_SECRET = randomUUID()
process.env.MASTER_KEY = Buffer.alloc(32, 4).toString('base64')
delete process.env.EMPLOYEE_API_KEYS_ENABLED
const db = new PrismaService({ datasources: { db: { url: testDatabaseUrl() } } })
const redisUrl = new URL(process.env.TEST_REDIS_URL || '')
if (redisUrl.protocol !== 'redis:' || !['127.0.0.1', 'localhost', 'redis'].includes(redisUrl.hostname)) throw new Error('Explicit local TEST_REDIS_URL required')
process.env.REDIS_URL = redisUrl.href
const redis = new Redis(redisUrl.href)
const received = []
let upstreamDelay = 0
let cliUpstream
const upstream = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  received.push({ headers: req.headers, body })
  if (cliUpstream) return cliUpstream(req, res, body)
  if (upstreamDelay) await delay(upstreamDelay)
  if (body.stream) {
    res.setHeader('content-type', 'text/event-stream')
    res.end(req.url === '/v1/responses' ? 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n' : req.url === '/v1/messages' ? 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n' : 'data: {"choices":[{"delta":{"content":"OK"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n')
  } else {
    res.setHeader('content-type', 'application/json')
    const response = req.url === '/v1/chat/completions'
      ? { object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }
      : req.url === '/v1/responses'
        ? { object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 3, output_tokens: 2 } }
        : { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }
    if (body.tools?.length) {
      if (req.url === '/v1/chat/completions') response.choices[0].message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_test', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }
      else if (req.url === '/v1/responses') response.output = [{ type: 'function_call', call_id: 'call_test', name: 'lookup', arguments: '{}' }]
      else response.content = [{ type: 'tool_use', id: 'call_test', name: 'lookup', input: {} }]
    }
    res.end(JSON.stringify(response))
  }
})
class KeyTestModule {}
Module({ controllers: [AuthController, DeviceGrantsController, UsageGroupsController, ProjectsController, UsersController, UsageController, AnalyticsController, EmployeeKeysController, GatewayController], providers: [AuthService, DeviceGrantsService, DeviceGrantLinksService, UsersService, AnalyticsService, AuthGuard, GatewayAuthGuard,
  EmployeeKeysService, UsageGroupsService, ProjectsService, ModelCatalogService, GatewayService, GroupBudgetService, ProjectBudgetService, { provide: PrismaService, useValue: db },
  RedisQuotaService] })(KeyTestModule)
const app = await NestFactory.create(KeyTestModule, { logger: false })
const cliRequests = []
app.use((req, res, next) => {
  res.once('finish', () => {
    if (cliUpstream) cliRequests.push({ method: req.method, path: req.path, status: res.statusCode,
      requestId: res.getHeader('x-ucli-request-id'), bodyKeys: Object.keys(req.body || {}) })
  })
  next()
})
app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
app.useGlobalInterceptors(new JsonSafeInterceptor())
try {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  await app.listen(0, '127.0.0.1')
  const base = await app.getUrl()
  process.env.PUBLIC_URL = base
  const a = await createOrganization(db)
  const adminToken = signAccessToken(a.actor)
  const employeeEmail = `${randomUUID()}@example.invalid`
  const employee = (await request('/api/v1/admin/users', 'POST', { email: employeeEmail, displayName: 'Employee' })).body
  assert.ok(employee.id)
  const employeeToken = signAccessToken({ ...a.actor, sub: employee.id, role: 'MEMBER', tokenVersion: 1 })
  const groups = app.get(UsageGroupsService)
  const group = (await request('/api/v1/admin/usage-groups', 'POST', { name: 'Key HTTP', type: 'REGION' })).body
  const otherGroup = (await request('/api/v1/admin/usage-groups', 'POST', { name: 'Other', type: 'REGION' })).body
  await request(`/api/v1/admin/usage-groups/${group.id}/members`, 'POST', { accountId: employee.id })
  const project = await db.project.create({ data: { organizationId: a.organization.id, regionId: group.id,
    code: 'KEY-HTTP', name: 'Key HTTP project' } })
  const otherProject = await db.project.create({ data: { organizationId: a.organization.id, regionId: otherGroup.id,
    code: 'KEY-OTHER', name: 'Other project' } })
  await db.projectMember.create({ data: { organizationId: a.organization.id, projectId: project.id, accountId: employee.id } })
  await db.projectMember.create({ data: { organizationId: a.organization.id, projectId: otherProject.id, accountId: employee.id } })
  await db.quotaPolicy.create({ data: { organizationId: a.organization.id, accountId: employee.id, dailyTokens: 1000000n, concurrency: 64 } })
  const encrypted = encryptSecret('upstream-only-test-secret', Buffer.alloc(32, 4))
  const channel = await db.channel.create({ data: { name: 'Local HTTP mock', provider: 'test', protocol: 'OPENAI', maxRetries: 0,
    baseUrl: `http://127.0.0.1:${upstream.address().port}`, keys: { create: { ciphertext: encrypted.ciphertext, iv: encrypted.iv, tag: encrypted.tag, suffix: 'test' } } } })
  const models = []
  for (const protocol of ['OPENAI_CHAT', 'OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES']) {
    models.push(await db.publicModel.create({ data: { id: randomUUID(), displayName: protocol, enabled: true, contextSize: 8192,
      channelModels: { create: { channelId: channel.id, upstreamModel: protocol, protocol, health: 'HEALTHY' } },
      prices: { create: { inputPerMillion: '1', outputPerMillion: '2', validFrom: new Date(0) } } } }))
  }
  await request(`/api/v1/admin/usage-groups/${group.id}/models`, 'PUT', { publicModelIds: models.map(model => model.id) })
  async function request(path, method = 'GET', body, token = adminToken, headers = {}) {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text()
    return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text }
  }
  const createPath = `/api/v1/admin/users/${employee.id}/api-keys`
  const created = await request(createPath, 'POST', { name: 'CLI', projectId: project.id })
  assert.equal(created.status, 201)
  assert.equal(created.headers.get('cache-control'), 'no-store')
  const key = created.body
  const me = await request('/api/v1/auth/me', 'GET', undefined, employeeToken)
  assert.equal(me.status, 200)
  assert.equal(me.headers.get('cache-control'), 'no-store')
  assert.deepEqual(me.body, { id: employee.id, displayName: 'Employee', email: employeeEmail, status: 'ACTIVE',
    pendingCredentialChange: false, organizationId: a.organization.id, organizationName: a.organization.name, role: 'MEMBER' })
  assert.equal((await request('/api/v1/auth/me', 'GET', undefined, key.secret)).status, 401)
  assert.deepEqual((await request('/api/v1/me/usage-groups', 'GET', undefined, employeeToken)).body.map(g => g.id), [group.id])
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
  assert.equal((await request(createPath, 'POST', { name: 'Forbidden', projectId: project.id }, employeeToken)).status, 401)
  const mine = await request('/api/v1/me/api-keys', 'GET', undefined, employeeToken)
  assert.deepEqual(mine.body.items.map(item => item.id), [key.id])
  assert.ok(!JSON.stringify(mine).includes(key.secret))
  assert.ok(!JSON.stringify(mine).includes('secretHash'))
  await db.account.update({ where: { id: a.account.id }, data: { passwordHash: await argon2.hash('http-admin-password') } })
  const revealPath = `/api/v1/admin/employee-api-keys/${key.id}/reveal`
  assert.equal((await request(revealPath, 'POST', { password: 'wrong' })).status, 401)
  const revealed = await request(revealPath, 'POST', { password: 'http-admin-password' })
  assert.equal(revealed.status, 200)
  assert.equal(revealed.headers.get('cache-control'), 'no-store')
  assert.equal(revealed.body.secret, key.secret)
  const device = await db.device.create({ data: { organizationId: a.organization.id, accountId: employee.id,
    name: 'Device', refreshTokenHash: randomUUID() } })
  const legacyGrant = await db.deviceGrant.create({ data: { organizationId: a.organization.id, accountId: employee.id, createdById: a.account.id, deviceId: device.id } })
  const deviceToken = signAccessToken({ ...a.actor, sub: employee.id, role: 'MEMBER', deviceId: device.id, tokenVersion: 1 })
  assert.equal((await request('/api/v1/admin/device-grants/group-requirement', 'PATCH', { required: true })).status, 409)
  assert.equal((await request(`/api/v1/admin/device-grants/${legacyGrant.id}/group`, 'PATCH', { groupId: group.id, accountId: employee.id, projectId: project.id })).status, 200)
  assert.equal((await request('/api/v1/admin/device-grants/group-requirement', 'PATCH', { required: true })).status, 200)
  assert.equal((await request(`/api/v1/admin/users/${employee.id}/device-grants`, 'POST', {})).status, 403)
  assert.equal((await request('/api/v1/me/api-keys', 'GET', undefined, deviceToken)).status, 403)
  assert.equal((await request('/v1/models', 'GET', undefined, deviceToken)).status, 200)
  assert.equal((await request('/anthropic/v1/models', 'GET', undefined, deviceToken)).status, 200)
  assert.equal((await request(`/api/v1/admin/employee-api-keys/${key.id}`, 'PATCH', { groupId: otherGroup.id })).status, 400)
  const otherCreated = await request(createPath, 'POST', { name: 'Other', projectId: otherProject.id })
  assert.equal(otherCreated.status, 201)
  const otherKey = otherCreated.body
  assert.deepEqual((await request('/v1/models', 'GET', undefined, otherKey.secret)).body.data, [])
  assert.equal((await request('/v1/chat/completions', 'POST', { model: models[0].id, messages: [] }, otherKey.secret)).status, 403)
  assert.equal(received.length, 0)
  const validChat = { model: models[0].id, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 16 }
  assert.equal((await request('/v1/chat/completions', 'POST', validChat, key.secret)).status, 429)
  assert.equal(received.length, 0)
  assert.equal((await request(`/api/v1/admin/projects/${project.id}/budget-adjustments`, 'POST', { operationId: randomUUID(), limitCny: '1', unlimited: false, reason: 'Local HTTP test project budget' })).status, 201)
  for (const [index, path, stream] of [[0, '/v1/chat/completions', false], [1, '/v1/responses', false],
    [2, '/anthropic/v1/messages', false], [0, '/v1/chat/completions', true], [1, '/v1/responses', true], [2, '/anthropic/v1/messages', true]]) {
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
  for (const [index, path] of [[0, '/v1/chat/completions'], [1, '/v1/responses'], [2, '/anthropic/v1/messages']]) {
    const tools = index === 0 ? [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }] : index === 1 ? [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }] : [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }]
    const first = await request(path, 'POST', { model: models[index].id, tools, ...(index === 1 ? { input: 'Hi', max_output_tokens: 16 } : { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 16 }) }, key.secret)
    assert.equal(first.status, 200)
    const followup = index === 0 ? { messages: [{ role: 'user', content: 'Hi' }, first.body.choices[0].message, { role: 'tool', tool_call_id: 'call_test', content: '42' }], max_tokens: 16 } : index === 1 ? { input: [...first.body.output, { type: 'function_call_output', call_id: 'call_test', output: '42' }], max_output_tokens: 16 } : { messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: first.body.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_test', content: '42' }] }], max_tokens: 16 }
    assert.equal((await request(path, 'POST', { model: models[index].id, ...followup }, key.secret)).status, 200)
    assert.ok(JSON.stringify(received.at(-1).body).includes('42'), 'Tool result must reach the supplier unchanged')
  }
  assert.equal((await request('/v1/chat/completions', 'POST', validChat, deviceToken)).status, 200)
  const logResponse = await request(`/api/v1/usage/logs?groupId=${group.id}`, 'GET', undefined, employeeToken)
  assert.equal(logResponse.status, 200)
  assert.equal(logResponse.body.length, 13)
  assert.equal(logResponse.body[0].employeeName, 'Employee')
  const overview = (await request(`/api/v1/analytics/overview?groupId=${group.id}`, 'GET', undefined, employeeToken)).body
  const balance = (await request(`/api/v1/admin/projects/${project.id}/budget`)).body
  assert.equal(overview.costCny, '0.00009100')
  assert.equal(balance.spentCny, overview.costCny)
  // Concurrent requests compete for pre-dispatch budget, not a post-hoc counter.
  await groups.replaceModels(a.actor, otherGroup.id, [models[0].id])
  assert.equal((await request(`/api/v1/admin/projects/${otherProject.id}/budget-adjustments`, 'POST', { operationId: randomUUID(), limitCny: '0.00050000', unlimited: false, reason: 'Concurrent admission' })).status, 201)
  upstreamDelay = 300
  const parallel = await Promise.all(Array.from({ length: 8 }, () => request('/v1/chat/completions', 'POST', validChat, otherKey.secret)))
  upstreamDelay = 0
  assert.equal(parallel.filter(r => r.status === 200).length, 1)
  assert.equal(parallel.filter(r => r.status === 429).length, 7)
  assert.equal((await request(`/api/v1/admin/projects/${otherProject.id}/budget-adjustments`, 'POST', { operationId: randomUUID(), limitCny: '0.00000700', unlimited: false, reason: 'Exhausted budget' })).status, 201)
  assert.equal((await request('/v1/chat/completions', 'POST', validChat, otherKey.secret)).status, 429)
  assert.equal(await redis.get(`concurrency:${a.organization.id}:${employee.id}:*`), '0')
  if (process.env.UCLI_TEST_REAL_CLI === '1') {
    const { runCliAcceptance } = await import('./employee-cli.mjs')
    await runCliAcceptance({ base, db, key, models, groupId: group.id, requests: cliRequests,
      setUpstream: handler => { cliUpstream = handler } })
    cliUpstream = undefined
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
  console.log('Employee gateway E2E passed: admin setup, three protocols/streams/tool roundtrips, PG/Redis accounting, concurrent budgets, device migration, 401/403/429 and revocation.')
} finally {
  await app.close()
  await new Promise(resolve => upstream.close(resolve))
  await db.$disconnect()
  await redis.quit()
}
