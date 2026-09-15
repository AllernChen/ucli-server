import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayService } from '../../apps/gateway/src/gateway.service.js'
import { GroupBudgetService } from '../../packages/quota/src/group-budget.service.js'
import { RedisQuotaService } from '../../packages/quota/src/redis-quota.js'
import { PrismaService } from '../../packages/database/src/prisma.service.js'
import { encryptSecret } from '../../packages/security/src/envelope-crypto.js'
import { createOrganization, withTestDatabase } from './database.js'

class ClientResponse extends Writable {
  headers = new Map<string, string>(); statusCode = 200; chunks: Buffer[] = []
  setHeader(name: string, value: string) { this.headers.set(name, value) }
  status(code: number) { this.statusCode = code; return this }
  send(value: Buffer) { this.end(value) }
  _write(chunk: Buffer, _encoding: string, callback: () => void) { this.chunks.push(chunk); callback() }
}
afterEach(() => vi.unstubAllGlobals())

describe.skipIf(!process.env.TEST_DATABASE_URL)('group gateway lifecycle (PostgreSQL + local upstream)', () => {
  it.each(['anthropic_messages', 'openai_chat'] as const)('settles DeepSeek cached tool history in CNY for normal and streaming employee key requests (%s)', protocol => withTestDatabase(async db => {
    const { organization, account, actor } = await createOrganization(db)
    const group = await db.usageGroup.create({ data: { organizationId: organization.id, name: 'DeepSeek cache test', type: 'PROJECT', defaultLimitCny: '1' } })
    await db.groupMember.create({ data: { organizationId: organization.id, accountId: account.id, groupId: group.id } })
    const key = await db.employeeApiKey.create({ data: { organizationId: organization.id, accountId: account.id, groupId: group.id,
      createdById: account.id, name: 'cache test', secretHash: randomUUID(), secretHint: 'test' } })
    process.env.MASTER_KEY = Buffer.alloc(32, 6).toString('base64')
    const encrypted = encryptSecret('fake-supplier-key', Buffer.alloc(32, 6))
    const anthropic = protocol === 'anthropic_messages'
    const channel = await db.channel.create({ data: { name: 'DeepSeek cache fixture', provider: 'test', protocol: anthropic ? 'ANTHROPIC' : 'OPENAI', maxRetries: 0,
      baseUrl: anthropic ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com', keys: { create: { ciphertext: encrypted.ciphertext, iv: encrypted.iv, tag: encrypted.tag, suffix: 'test' } } } })
    const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Cache fixture', enabled: true, contextSize: 8192,
      prices: { create: { inputPerMillion: '1', outputPerMillion: '2', cachedPerMillion: '0.1', validFrom: new Date(0) } },
      channelModels: { create: { channelId: channel.id, upstreamModel: 'deepseek-v4-flash', protocol: anthropic ? 'ANTHROPIC_MESSAGES' : 'OPENAI_CHAT', health: 'HEALTHY' } } } })
    await db.groupModelAccess.create({ data: { organizationId: organization.id, groupId: group.id, publicModelId: model.id } })
    const budget = new GroupBudgetService(db as PrismaService)
    const service = new GatewayService(db as PrismaService, {} as RedisQuotaService, undefined, budget)
    const identity = { ...actor, credentialType: 'API_KEY' as const, apiKeyId: key.id, groupId: group.id }
    const marker = { type: 'ephemeral' }
    const body = anthropic ? { model: model.id, max_tokens: 16, system: [{ type: 'text', text: 'Help', cache_control: marker }],
      tools: [{ name: 'read', input_schema: { type: 'object' }, cache_control: marker }],
      messages: [{ role: 'user', content: 'Read' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Hello', cache_control: marker }] }] }
      : { model: model.id, max_tokens: 16, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
        messages: [{ role: 'user', content: 'Read' },
          { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 't1', content: 'Hello' }] }
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toBe(anthropic ? 'https://api.deepseek.com/anthropic/v1/messages' : 'https://api.deepseek.com/v1/chat/completions')
      const sent = JSON.parse(String(init.body))
      expect(sent).toMatchObject({ ...body, model: 'deepseek-v4-flash' })
      if (!anthropic) {
        const usage = { prompt_tokens: 30, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 10, completion_tokens: 5 }
        return sent.stream ? new Response(`data: ${JSON.stringify({ usage })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
          : new Response(JSON.stringify({ usage }))
      }
      return sent.stream ? new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"output_tokens":0}}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
        : new Response('{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"output_tokens":5}}')
    })
    for (const stream of [false, true]) {
      const response = new ClientResponse()
      await service.relay({ protocol, body: { ...body, stream }, headers: {}, principal: identity, response: response as any })
      const requestId = response.headers.get('x-ucli-request-id')!
      await vi.waitFor(async () => expect(await db.usageLog.count({ where: { requestId } })).toBe(1))
      response.emit('close')
      const entry = await db.groupBudgetEntry.findUniqueOrThrow({ where: { operationId: `request:${requestId}` } })
      expect(entry.status).toBe('SETTLED')
      expect(entry.settledCny.toFixed(8)).toBe('0.00002200')
      const log = await db.usageLog.findUniqueOrThrow({ where: { requestId } })
      expect(log).toMatchObject({ inputTokens: 30n, cachedTokens: 20n, outputTokens: 5n, usageSource: 'UPSTREAM', apiKeyId: key.id })
      expect(log.actorSnapshot).toMatchObject({ employeeName: 'Test employee' })
    }
    const period = await db.groupBudgetPeriod.findFirstOrThrow({ where: { groupId: group.id } })
    expect(period.spentCny.toFixed(8)).toBe('0.00004400')
    expect(period.reservedCny.toFixed(8)).toBe('0.00000000')
  }))

  it('rejects zero budgets, caps upstream output and settles normal/streaming calls once', () => withTestDatabase(async db => {
    const { organization, account, actor } = await createOrganization(db)
    const group = await db.usageGroup.create({ data: { organizationId: organization.id, name: 'Gateway budget', type: 'PROJECT' } })
    await db.groupMember.create({ data: { organizationId: organization.id, accountId: account.id, groupId: group.id } })
    const key = await db.employeeApiKey.create({ data: { organizationId: organization.id, accountId: account.id, groupId: group.id,
      createdById: account.id, name: 'test', secretHash: randomUUID(), secretHint: 'test' } })
    process.env.MASTER_KEY = Buffer.alloc(32, 6).toString('base64')
    const encrypted = encryptSecret('supplier-only', Buffer.alloc(32, 6))
    const channel = await db.channel.create({ data: { name: 'Budget upstream', provider: 'test', protocol: 'OPENAI', maxRetries: 0,
      baseUrl: 'https://example.invalid', keys: { create: { ciphertext: encrypted.ciphertext, iv: encrypted.iv, tag: encrypted.tag, suffix: 'only' } } } })
    const model = await db.publicModel.create({ data: { id: randomUUID(), displayName: 'Budget test', enabled: true, contextSize: 8192,
      prices: { create: { inputPerMillion: '1', outputPerMillion: '2', validFrom: new Date(0) } },
      channelModels: { create: { channelId: channel.id, upstreamModel: 'test', protocol: 'OPENAI_CHAT', health: 'HEALTHY' } } } })
    await db.groupModelAccess.create({ data: { organizationId: organization.id, groupId: group.id, publicModelId: model.id } })
    const budget = new GroupBudgetService(db as PrismaService)
    // No legacy quota policy in this fixture; Redis must not be called.
    const quota = { expiredReservations: async () => [] } as unknown as RedisQuotaService
    const service = new GatewayService(db as PrismaService, quota, undefined, budget)
    const identity = { ...actor, credentialType: 'API_KEY' as const, apiKeyId: key.id, groupId: group.id }
    const sent: any[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); sent.push(body)
      return body.stream ? new Response('data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        : new Response('{"usage":{"prompt_tokens":3,"completion_tokens":2}}')
    })
    const invoke = (response: ClientResponse, stream = false) => service.relay({ protocol: 'openai_chat', body: { model: model.id,
      messages: [{ role: 'user', content: 'Hi' }], stream }, headers: {}, principal: identity, response: response as any })
    await expect(invoke(new ClientResponse())).rejects.toMatchObject({ status: 429 })
    expect(sent).toHaveLength(0)
    await db.usageGroup.update({ where: { id: group.id }, data: { defaultLimitCny: '1' } })
    for (const stream of [false, true]) {
      const response = new ClientResponse(); await invoke(response, stream)
      const requestId = response.headers.get('x-ucli-request-id')!
      for (let i = 0; i < 100; i++) {
        if (await db.usageLog.findUnique({ where: { requestId } })) break
        await delay(10)
      }
      response.emit('close')
      const entry = await db.groupBudgetEntry.findUniqueOrThrow({ where: { operationId: `request:${requestId}` } })
      expect(entry.status).toBe('SETTLED')
      expect(entry.settledCny.toFixed(8)).toBe('0.00000700')
      expect(await db.usageLog.count({ where: { requestId, apiKeyId: key.id, deviceId: null, groupId: group.id } })).toBe(1)
      expect((await db.usageLog.findUniqueOrThrow({ where: { requestId } })).actorSnapshot).toMatchObject({ keyName: 'test', keyHint: 'test' })
    }
    expect(sent.map(body => body.max_tokens)).toEqual([4096, 4096])
    expect((await db.groupBudgetPeriod.findFirstOrThrow({ where: { groupId: group.id } })).spentCny.toFixed(8)).toBe('0.00001400')

    await db.channel.update({ where: { id: channel.id }, data: { maxRetries: 1 } })
    let calls = 0
    vi.stubGlobal('fetch', async () => new Response('{"usage":{"prompt_tokens":3,"completion_tokens":2}}', { status: ++calls === 1 ? 503 : 200 }))
    const retried = new ClientResponse(); await invoke(retried)
    const billed = await db.usageLog.findUniqueOrThrow({ where: { requestId: retried.headers.get('x-ucli-request-id')! }, include: { routes: true } })
    expect(billed.costUsd.toFixed(8)).toBe('0.00001400')
    expect(billed.routes.map(r => r.costCny?.toFixed(8))).toEqual(['0.00000700', '0.00000700'])

    calls = 0
    vi.stubGlobal('fetch', async () => { if (++calls === 1) throw new Error('Unknown supplier result'); return new Response('{"usage":{"prompt_tokens":3,"completion_tokens":2}}') })
    const unknown = new ClientResponse(); await invoke(unknown)
    const requestId = unknown.headers.get('x-ucli-request-id')!
    const pending = await db.groupBudgetEntry.findUniqueOrThrow({ where: { operationId: `request:${requestId}` } })
    expect(pending.status).toBe('RECONCILIATION_REQUIRED'); expect(pending.reservedCny.gt(0)).toBe(true)
    expect(pending.settledCny.toFixed(8)).toBe('0.00000700')
    const uncertain = await db.usageLog.findUniqueOrThrow({ where: { requestId }, include: { routes: { orderBy: { attempt: 'asc' } } } })
    expect(uncertain.costSnapshot).toMatchObject({ billingState: 'UNKNOWN' })
    expect(uncertain.routes[0].costCny).toBeNull()
    await budget.reconcile(actor, group.id, pending.id, { operationId: randomUUID(), actualCny: '0.00000700', action: 'SETTLE', reason: 'Supplier confirms first attempt unbilled',
      routes: uncertain.routes.map((r, index) => ({ id: r.id, costCny: index ? '0.00000700' : '0' })) })
    const period = await db.groupBudgetPeriod.findFirstOrThrow({ where: { groupId: group.id } })
    expect(period.reservedCny.toFixed(8)).toBe('0.00000000')
    expect(period.spentCny.toFixed(8)).toBe('0.00003500')

    vi.stubGlobal('fetch', async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
    const interrupted = new ClientResponse(); await invoke(interrupted, true)
    let interruptedEntry
    for (let i = 0; i < 100; i++) {
      interruptedEntry = await db.groupBudgetEntry.findUnique({ where: { operationId: `request:${interrupted.headers.get('x-ucli-request-id')}` } })
      if (interruptedEntry?.status !== 'RESERVED') break
      await delay(10)
    }
    expect(interruptedEntry?.status).toBe('RECONCILIATION_REQUIRED')
    expect(interruptedEntry?.reservedCny.gt(0)).toBe(true)

    vi.stubGlobal('fetch', async () => new Response('{"usage":{"prompt_tokens":3,"completion_tokens":2}}'))
    const failedSettlement = vi.spyOn(budget, 'settle').mockRejectedValue(new Error('Database temporarily unavailable'))
    const failedResponse = new ClientResponse()
    await expect(invoke(failedResponse)).rejects.toMatchObject({ status: 503 })
    failedSettlement.mockRestore()
    const failedId = failedResponse.headers.get('x-ucli-request-id')!
    const failedEntry = await db.groupBudgetEntry.findUniqueOrThrow({ where: { operationId: `request:${failedId}` } })
    expect(failedEntry.status).toBe('RECONCILIATION_REQUIRED'); expect(failedEntry.reservedCny.gt(0)).toBe(true)
    expect(await db.usageLog.count({ where: { requestId: failedId } })).toBe(0)

    let cancelled = false
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"in progress"}}]}\n\n')) },
      cancel() { cancelled = true }
    })))
    const cancelledResponse = new ClientResponse(); await invoke(cancelledResponse, true); cancelledResponse.destroy()
    let cancelledEntry
    for (let i = 0; i < 100; i++) {
      cancelledEntry = await db.groupBudgetEntry.findUnique({ where: { operationId: `request:${cancelledResponse.headers.get('x-ucli-request-id')}` } })
      if (cancelledEntry?.status === 'RECONCILIATION_REQUIRED') break
      await delay(10)
    }
    expect(cancelled).toBe(true); expect(cancelledEntry?.status).toBe('RECONCILIATION_REQUIRED')
  }))
})
