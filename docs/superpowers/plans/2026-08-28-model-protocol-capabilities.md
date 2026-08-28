# UCLI Model Protocol Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish each server model's callable Gateway protocols, return precise route failure codes, and deliver a self-contained upgrade plan for the independently maintained UCLI client.

**Architecture:** Add a pure capability projector to Gateway Core and use it from both the API Bootstrap catalog and Gateway model catalog. Gateway routing will compare the requested protocol with the same static capability projection before applying health/cost routing, carry one request ID through upstream relay, and return structured no-store failures. Client code remains out of scope; this repository publishes its exact contract and implementation handoff.

**Tech Stack:** TypeScript 5.9, NestJS 11, Prisma 6, Express 5, Vitest 3, Node.js 22, Markdown contract tests, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-28-model-protocol-capabilities-design.md`

## Global Constraints

- UCLI remains independently installable and usable when no server is registered or server capabilities fail.
- Model protocol values are exactly `openai_responses`, `openai_chat`, `anthropic_messages`, and `gemini`, in that stable order.
- Static capabilities require an enabled, non-archived public model, mapping, channel, and at least one enabled non-archived channel key.
- Mapping/channel/key health, key isolation, circuit state, quota, and current cost availability do not remove a static protocol capability.
- Bootstrap and Gateway model catalogs must use the same pure protocol projection and access-policy rules.
- The old client behavior that assumes `models[0]` supports Responses receives no compatibility fallback.
- External 503 codes are exactly `model_protocol_unavailable`, `model_channel_unavailable`, and `upstream_unavailable`; each response includes `requestId` and `retryable` and uses `Cache-Control: no-store`.
- Logs and handoffs must never include access tokens, refresh tokens, device-link secrets, supplier keys, request/response bodies, or complete headers.
- This repository does not modify files in `F:\projects\ucli`; it produces a self-contained handoff for that separate project.
- Production supplier keys are entered manually by a platform administrator and are never extracted or copied from existing encrypted records.
- No database schema change or data migration is required.

---

## File Structure

- Create `packages/gateway-core/src/model-capabilities.ts`: pure upstream-to-client protocol projection and stable ordering.
- Create `test/gateway/model-capabilities.test.ts`: capability truth table and static configuration boundaries.
- Modify `apps/api/src/client.controller.ts`: query static mapping data and add required `protocols` to Bootstrap models.
- Modify `test/catalog/catalog-runtime-isolation.test.ts`: Bootstrap filtering and capability coverage.
- Modify `test/auth/device-grant-client-metadata.test.ts` and `test/auth/device-grant-auth-matrix.test.ts`: preserve authorization/admin behavior with the enriched model shape.
- Modify `apps/gateway/src/gateway.service.ts`: enrich Gateway catalog, classify routing failures, propagate request IDs, and write sanitized failure logs.
- Modify `apps/gateway/src/gateway.controller.ts`: publish UCLI model extensions in the OpenAI-style list.
- Create `apps/gateway/src/gateway-errors.ts`: exact external 503 response builder and sanitized structured logger.
- Modify `packages/gateway-core/src/relay.ts`: accept the caller-generated request ID instead of generating a second ID.
- Modify `test/gateway/gateway.service.test.ts`, `test/gateway/relay.test.ts`, and create `test/gateway/gateway.controller.test.ts`: catalog, error, logging, and request-ID contracts.
- Modify `docs/ucli-client-protocol.md`: authoritative server contract.
- Create `docs/ucli-client-model-protocol-upgrade.md`: standalone UCLI implementation and evidence handoff.
- Modify `test/auth/device-grant-protocol.test.ts`: parse and lock the new documentation examples.
- Modify `README.md`, `DEPLOY.md`, and `CHANGELOG.md`: operator-facing capability and Responses-channel requirements.
- Modify this plan after verification: append immutable implementation evidence without credentials or user identity.

---

### Task 1: Add the Shared Model Capability Projector

**Files:**

- Create: `packages/gateway-core/src/model-capabilities.ts`
- Create: `test/gateway/model-capabilities.test.ts`

**Interfaces:**

- Consumes: `GatewayProtocol` from `packages/gateway-core/src/protocol.ts` and Prisma protocol string values.
- Produces: `configuredClientProtocols(mappings)` and `upstreamProtocolsForClient(protocol)` for API and Gateway callers.

- [ ] **Step 1: Write the failing protocol projection tests**

Create `test/gateway/model-capabilities.test.ts` with fixtures that assert the exact truth table and configuration boundary:

```ts
import { describe, expect, it } from 'vitest'
import { configuredClientProtocols, upstreamProtocolsForClient } from '../../packages/gateway-core/src/model-capabilities.js'

function mapping(protocol: 'OPENAI_RESPONSES' | 'OPENAI_CHAT' | 'ANTHROPIC_MESSAGES' | 'GEMINI', overrides: any = {}) {
  const { channel: channelOverrides = {}, ...mappingOverrides } = overrides
  return {
    protocol, enabled: true, deletedAt: null,
    ...mappingOverrides,
    channel: { enabled: true, deletedAt: null, keys: [{ enabled: true, deletedAt: null }], ...channelOverrides }
  }
}

describe('model protocol capabilities', () => {
  it('projects upstream protocols to stable deduplicated client protocols', () => {
    expect(configuredClientProtocols([
      mapping('GEMINI'), mapping('OPENAI_CHAT'), mapping('ANTHROPIC_MESSAGES'), mapping('OPENAI_RESPONSES'), mapping('GEMINI')
    ])).toEqual(['openai_responses', 'openai_chat', 'anthropic_messages', 'gemini'])
  })

  it.each([
    ['disabled mapping', { enabled: false }],
    ['archived mapping', { deletedAt: new Date() }],
    ['disabled channel', { channel: { enabled: false } }],
    ['archived channel', { channel: { deletedAt: new Date() } }],
    ['channel without a key', { channel: { keys: [] } }],
    ['disabled key', { channel: { keys: [{ enabled: false, deletedAt: null }] } }],
    ['archived key', { channel: { keys: [{ enabled: true, deletedAt: new Date() }] } }]
  ])('excludes a %s', (_label, overrides) => {
    expect(configuredClientProtocols([mapping('OPENAI_RESPONSES', overrides)])).toEqual([])
  })

  it('does not treat health, isolation, or circuit state as static capability inputs', () => {
    expect(configuredClientProtocols([mapping('OPENAI_RESPONSES', {
      health: 'UNHEALTHY', channel: { health: 'UNHEALTHY', circuitOpenUntil: new Date(), keys: [
        { enabled: true, deletedAt: null, health: 'UNHEALTHY', isolatedUntil: new Date() }
      ] }
    })])).toEqual(['openai_responses'])
  })

  it('returns the exact upstream protocol set accepted by each client endpoint', () => {
    expect(upstreamProtocolsForClient('openai_responses')).toEqual(['OPENAI_RESPONSES'])
    expect(upstreamProtocolsForClient('openai_chat')).toEqual(['OPENAI_CHAT', 'GEMINI'])
    expect(upstreamProtocolsForClient('anthropic_messages')).toEqual(['ANTHROPIC_MESSAGES'])
    expect(upstreamProtocolsForClient('gemini')).toEqual(['GEMINI'])
  })
})
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```powershell
npx vitest run test/gateway/model-capabilities.test.ts
```

Expected: FAIL because `packages/gateway-core/src/model-capabilities.ts` does not exist.

- [ ] **Step 3: Implement the pure capability module**

Create `packages/gateway-core/src/model-capabilities.ts` with these exported types and functions:

```ts
import type { GatewayProtocol } from './protocol.js'

export type UpstreamGatewayProtocol = 'OPENAI_RESPONSES' | 'OPENAI_CHAT' | 'ANTHROPIC_MESSAGES' | 'GEMINI'

export interface ModelProtocolMapping {
  protocol: UpstreamGatewayProtocol
  enabled: boolean
  deletedAt: Date | null
  channel: {
    enabled: boolean
    deletedAt: Date | null
    keys: Array<{ enabled: boolean; deletedAt: Date | null }>
  }
}

const CLIENT_PROTOCOL_ORDER: readonly GatewayProtocol[] = [
  'openai_responses', 'openai_chat', 'anthropic_messages', 'gemini'
]

const CLIENT_UPSTREAMS: Record<GatewayProtocol, readonly UpstreamGatewayProtocol[]> = {
  openai_responses: ['OPENAI_RESPONSES'],
  openai_chat: ['OPENAI_CHAT', 'GEMINI'],
  anthropic_messages: ['ANTHROPIC_MESSAGES'],
  gemini: ['GEMINI']
}

export function upstreamProtocolsForClient(protocol: GatewayProtocol): UpstreamGatewayProtocol[] {
  return [...CLIENT_UPSTREAMS[protocol]]
}

export function configuredClientProtocols(mappings: readonly ModelProtocolMapping[]): GatewayProtocol[] {
  const upstream = new Set(mappings.filter(item =>
    item.enabled && !item.deletedAt && item.channel.enabled && !item.channel.deletedAt &&
    item.channel.keys.some(key => key.enabled && !key.deletedAt)
  ).map(item => item.protocol))
  return CLIENT_PROTOCOL_ORDER.filter(protocol => CLIENT_UPSTREAMS[protocol].some(item => upstream.has(item)))
}
```

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```powershell
npx vitest run test/gateway/model-capabilities.test.ts
npm run typecheck
```

Expected: capability tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the shared projector**

```powershell
git add -- packages/gateway-core/src/model-capabilities.ts test/gateway/model-capabilities.test.ts
git diff --cached --check
git commit -m "feat(gateway): project model protocol capabilities"
```

---

### Task 2: Enrich Bootstrap with Required Protocol Capabilities

**Files:**

- Modify: `apps/api/src/client.controller.ts`
- Modify: `test/catalog/catalog-runtime-isolation.test.ts`
- Modify: `test/auth/device-grant-client-metadata.test.ts`
- Modify: `test/auth/device-grant-auth-matrix.test.ts`

**Interfaces:**

- Consumes: `configuredClientProtocols(ModelProtocolMapping[])` from Task 1.
- Produces: Bootstrap model items `{ id, displayName, contextSize, protocols }`, excluding models whose projected protocols are empty.

- [ ] **Step 1: Write failing Bootstrap catalog tests**

Extend the Bootstrap harness with one public model containing `OPENAI_RESPONSES`, `GEMINI`, disabled, archived, and keyless mappings. Assert:

```ts
expect(result.models).toEqual([{
  id: 'model-1', displayName: 'Model 1', contextSize: 128000,
  protocols: ['openai_responses', 'openai_chat', 'gemini']
}])
expect(prisma.publicModel.findMany).toHaveBeenCalledWith(expect.objectContaining({
  where: { enabled: true, deletedAt: null, contextSize: { gt: 0 } },
  include: expect.objectContaining({
    policies: true,
    channelModels: expect.objectContaining({
      select: expect.objectContaining({ protocol: true, enabled: true, deletedAt: true, channel: expect.any(Object) })
    })
  })
}))
```

Add a second accessible public model with `channelModels: []` and assert it is omitted. Update existing device metadata and administrator Bootstrap fixtures to include `channelModels: []`; their authorization behavior and empty model result must remain unchanged.

- [ ] **Step 2: Run the Bootstrap tests and confirm the red state**

```powershell
npx vitest run test/catalog/catalog-runtime-isolation.test.ts test/auth/device-grant-client-metadata.test.ts test/auth/device-grant-auth-matrix.test.ts
```

Expected: FAIL because Bootstrap neither loads channel mappings nor returns `protocols`.

- [ ] **Step 3: Query static mapping inputs and project Bootstrap models**

In `ClientController.bootstrap`, add the shared import and replace the public-model include with:

```ts
include: {
  policies: true,
  channelModels: { select: {
    protocol: true, enabled: true, deletedAt: true,
    channel: { select: {
      enabled: true, deletedAt: true,
      keys: { select: { enabled: true, deletedAt: true } }
    } }
  } }
}
```

Project after access-policy filtering:

```ts
.map(({ id, displayName, contextSize, channelModels }) => ({
  id, displayName, contextSize, protocols: configuredClientProtocols(channelModels)
}))
.filter(model => model.protocols.length > 0)
```

Do not inspect health, isolation, circuit, quota, or cost fields in this query.

- [ ] **Step 4: Run Bootstrap tests and typecheck**

```powershell
npx vitest run test/catalog/catalog-runtime-isolation.test.ts test/auth/device-grant-client-metadata.test.ts test/auth/device-grant-auth-matrix.test.ts
npm run typecheck
```

Expected: all focused tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the Bootstrap contract**

```powershell
git add -- apps/api/src/client.controller.ts test/catalog/catalog-runtime-isolation.test.ts test/auth/device-grant-client-metadata.test.ts test/auth/device-grant-auth-matrix.test.ts
git diff --cached --check
git commit -m "feat(client): publish model protocol capabilities"
```

---

### Task 3: Make the Gateway Model Catalog Match Bootstrap

**Files:**

- Modify: `apps/gateway/src/gateway.service.ts`
- Modify: `apps/gateway/src/gateway.controller.ts`
- Modify: `test/gateway/gateway.service.test.ts`
- Create: `test/gateway/gateway.controller.test.ts`

**Interfaces:**

- Consumes: Task 1's projector and existing `ModelAccessPrincipal` policy filtering.
- Produces: Gateway catalog items `{ id, displayName, contextSize, protocols }` and OpenAI-style wire items with `display_name`, `context_size`, and `protocols`.

- [ ] **Step 1: Write failing service and controller catalog tests**

Update the Gateway harness `publicModel.findMany` result to:

```ts
[{ id: 'gpt-4o', displayName: 'GPT-4o', contextSize: 128000, enabled: true, policies: [], channelModels: [{
  protocol: 'OPENAI_RESPONSES', enabled: true, deletedAt: null,
  channel: { enabled: true, deletedAt: null, keys: [{ enabled: true, deletedAt: null }] }
}] }]
```

Assert `service.models(principal)` returns:

```ts
[{ id: 'gpt-4o', displayName: 'GPT-4o', contextSize: 128000, protocols: ['openai_responses'] }]
```

Create `test/gateway/gateway.controller.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { GatewayController } from '../../apps/gateway/src/gateway.controller.js'

describe('gateway model catalog', () => {
  it('publishes UCLI capability extensions in the OpenAI list envelope', async () => {
    const gateway = { models: vi.fn().mockResolvedValue([{
      id: 'model-1', displayName: 'Model 1', contextSize: 128000, protocols: ['openai_responses']
    }]) }
    const controller = new GatewayController(gateway as any)
    await expect(controller.models({ principal: {
      sub: 'account-1', organizationId: 'org-1', deviceId: 'device-1', role: 'MEMBER'
    } })).resolves.toEqual({ object: 'list', data: [{
      id: 'model-1', object: 'model', owned_by: 'ucli', display_name: 'Model 1',
      context_size: 128000, protocols: ['openai_responses']
    }] })
  })
})
```

- [ ] **Step 2: Run the catalog tests and confirm the red state**

```powershell
npx vitest run test/gateway/gateway.service.test.ts test/gateway/gateway.controller.test.ts
```

Expected: FAIL because Gateway models do not load mappings or expose extension fields.

- [ ] **Step 3: Implement the matching Gateway catalog**

In `GatewayService.models`, query and project with:

```ts
const models = await this.prisma.publicModel.findMany({
  where: { enabled: true, deletedAt: null, contextSize: { gt: 0 } },
  include: {
    policies: true,
    channelModels: { select: {
      protocol: true, enabled: true, deletedAt: true,
      channel: { select: {
        enabled: true, deletedAt: true,
        keys: { select: { enabled: true, deletedAt: true } }
      } }
    } }
  }
})
return models.filter(model => canAccessModel(model.policies, principal))
  .map(({ id, displayName, contextSize, channelModels }) => ({
    id, displayName, contextSize, protocols: configuredClientProtocols(channelModels)
  }))
  .filter(model => model.protocols.length > 0)
```

In `GatewayController.models`, map the service result exactly as follows:

```ts
return { object: 'list', data: models.map(model => ({
  id: model.id, object: 'model', owned_by: 'ucli',
  display_name: model.displayName, context_size: model.contextSize, protocols: model.protocols
})) }
```

- [ ] **Step 4: Run Gateway catalog, Bootstrap, and type tests together**

```powershell
npx vitest run test/gateway/model-capabilities.test.ts test/gateway/gateway.service.test.ts test/gateway/gateway.controller.test.ts test/catalog/catalog-runtime-isolation.test.ts
npm run typecheck
```

Expected: all focused tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the Gateway catalog**

```powershell
git add -- apps/gateway/src/gateway.service.ts apps/gateway/src/gateway.controller.ts test/gateway/gateway.service.test.ts test/gateway/gateway.controller.test.ts
git diff --cached --check
git commit -m "feat(gateway): expose model protocol catalog"
```

---

### Task 4: Return Precise Route Errors with One Request ID

**Files:**

- Create: `apps/gateway/src/gateway-errors.ts`
- Modify: `apps/gateway/src/gateway.service.ts`
- Modify: `packages/gateway-core/src/relay.ts`
- Modify: `test/gateway/gateway.service.test.ts`
- Modify: `test/gateway/relay.test.ts`

**Interfaces:**

- Consumes: `configuredClientProtocols`, `upstreamProtocolsForClient`, Express `Response`, and the existing relay attempt list.
- Produces: exact 503 JSON bodies, `X-UCLI-Request-ID`, `Cache-Control: no-store`, caller-provided upstream request IDs, and sanitized structured failure events.

- [ ] **Step 1: Write failing routing error tests**

Replace the generic no-channel test with separate cases. For `openai_responses` against a model that only projects `openai_chat`, assert:

```ts
const error = await service.relay(args).catch(error => error)
expect(error.getResponse()).toEqual({
  statusCode: 503,
  code: 'model_protocol_unavailable',
  message: 'The model does not support the requested protocol',
  requestId: expect.any(String),
  retryable: false
})
expect(prisma.channelModel.findMany).not.toHaveBeenCalled()
expect(quota.reserve).not.toHaveBeenCalled()
expect(response.setHeader).toHaveBeenCalledWith('cache-control', 'no-store')
expect(response.setHeader).toHaveBeenCalledWith('x-ucli-request-id', error.getResponse().requestId)
```

For a statically compatible model whose candidate query returns `[]`, assert:

```ts
const error = await service.relay(args).catch(error => error)
expect(error.getResponse()).toMatchObject({
  statusCode: 503, code: 'model_channel_unavailable',
  message: 'No model channel is currently available', retryable: true,
  requestId: expect.any(String)
})
expect(quota.reserve).not.toHaveBeenCalled()
expect(prisma.usageLog.create).not.toHaveBeenCalled()
expect(console.warn).toHaveBeenCalledWith('gateway-route-failed', expect.objectContaining({
  event: 'gateway_route_failed', code: 'model_channel_unavailable', routeAttempts: 0,
  requestId: error.getResponse().requestId
}))
```

For upstream exhaustion, assert:

```ts
const error = await service.relay(args).catch(error => error)
const body = error.getResponse()
expect(body).toMatchObject({
  statusCode: 503, code: 'upstream_unavailable',
  message: 'No upstream channel succeeded', retryable: true,
  requestId: expect.any(String)
})
expect(response.setHeader).toHaveBeenCalledWith('x-ucli-request-id', body.requestId)
expect(prisma.usageLog.create.mock.calls[0][0].data).toMatchObject({
  requestId: body.requestId, statusCode: 503, routeAttempts: 1,
  errorCode: 'UPSTREAM_UNAVAILABLE'
})
expect(console.warn).toHaveBeenCalledWith('gateway-route-failed', expect.objectContaining({
  code: 'upstream_unavailable', requestId: body.requestId, routeAttempts: 1
}))
```

Extend `test/gateway/relay.test.ts` with explicit `requestId: 'request-1'` success and exhaustion cases. Assert the upstream `x-ucli-request-id` header and returned/failure ID both equal `request-1`; existing management model-test callers may omit the argument and receive a generated UUID.

- [ ] **Step 2: Run error and relay tests and confirm the red state**

```powershell
npx vitest run test/gateway/gateway.service.test.ts test/gateway/relay.test.ts
```

Expected: FAIL because no precise errors exist and `relayRequest` still creates its own ID.

- [ ] **Step 3: Add the exact Gateway error module**

Create `apps/gateway/src/gateway-errors.ts` with:

```ts
import { ServiceUnavailableException } from '@nestjs/common'

export type GatewayUnavailableCode =
  | 'model_protocol_unavailable'
  | 'model_channel_unavailable'
  | 'upstream_unavailable'

const DETAILS: Record<GatewayUnavailableCode, { message: string; retryable: boolean }> = {
  model_protocol_unavailable: { message: 'The model does not support the requested protocol', retryable: false },
  model_channel_unavailable: { message: 'No model channel is currently available', retryable: true },
  upstream_unavailable: { message: 'No upstream channel succeeded', retryable: true }
}

export function gatewayUnavailable(code: GatewayUnavailableCode, requestId: string) {
  return new ServiceUnavailableException({ statusCode: 503, code, ...DETAILS[code], requestId })
}

export function logGatewayFailure(input: {
  requestId: string
  organizationId: string
  accountId: string
  deviceId: string
  publicModelId: string
  protocol: string
  code: GatewayUnavailableCode
  routeAttempts: number
}) {
  console.warn('gateway-route-failed', { event: 'gateway_route_failed', ...input, timestamp: new Date().toISOString() })
}
```

The logger accepts only the listed scalar fields. Do not pass body, headers, tokens, provider response, channel key, or exception objects.

- [ ] **Step 4: Make the relay use the Gateway-generated request ID**

Change `relayRequest` input to accept `requestId?: string`, resolve it once with `const resolvedRequestId = requestId ?? randomUUID()`, and preserve that resolved value in upstream headers, successful results, and the thrown exhaustion object. `GatewayService` must always pass its already-generated ID; `ModelTestingService` may omit it because those administrative tests do not have an external Gateway response to correlate.

- [ ] **Step 5: Classify static capability, candidate, and upstream failures**

In `GatewayService.relay`, extend the existing public model include with the static mappings required for the capability check:

```ts
channelModels: { select: {
  protocol: true, enabled: true, deletedAt: true,
  channel: { select: {
    enabled: true, deletedAt: true,
    keys: { select: { enabled: true, deletedAt: true } }
  } }
}
```

Then apply this sequence:

1. Keep the existing 404 access-control check before capability disclosure.
2. Generate one `requestId = randomUUID()` after that check.
3. Set `x-ucli-request-id` and `cache-control: no-store` on the Express response.
4. Project `const configuredProtocols = configuredClientProtocols(model.channelModels)`. If `!configuredProtocols.includes(protocol)`, log `model_protocol_unavailable` and throw `gatewayUnavailable('model_protocol_unavailable', requestId)` before candidate, quota, or upstream work.
5. Use `upstreamProtocolsForClient(protocol)` in the candidate Prisma filter instead of the local `CLIENT_UPSTREAMS` table.
6. If candidates are empty, log `model_channel_unavailable` and throw `gatewayUnavailable('model_channel_unavailable', requestId)` before quota or upstream work.
7. Call `relayRequest({ requestId, ... })`.
8. On upstream exhaustion, retain the existing usage/route attempt and circuit updates, log `upstream_unavailable`, then throw `gatewayUnavailable('upstream_unavailable', requestId)`.

Keep the internal usage `errorCode: 'UPSTREAM_UNAVAILABLE'`; only the public API code changes to lowercase.

- [ ] **Step 6: Run focused error, relay, and type tests**

```powershell
npx vitest run test/gateway/model-capabilities.test.ts test/gateway/relay.test.ts test/gateway/gateway.service.test.ts test/gateway/gateway.controller.test.ts
npm run typecheck
```

Expected: all tests PASS. No test snapshot or terminal output contains a supplier key, bearer token, device-link secret, or request/response body.

- [ ] **Step 7: Commit precise Gateway failures**

```powershell
git add -- apps/gateway/src/gateway-errors.ts apps/gateway/src/gateway.service.ts packages/gateway-core/src/relay.ts test/gateway/gateway.service.test.ts test/gateway/relay.test.ts
git diff --cached --check
git commit -m "feat(gateway): classify unavailable model routes"
```

---

### Task 5: Publish the Server Contract and UCLI Upgrade Handoff

**Files:**

- Modify: `docs/ucli-client-protocol.md`
- Create: `docs/ucli-client-model-protocol-upgrade.md`
- Modify: `test/auth/device-grant-protocol.test.ts`
- Modify: `README.md`
- Modify: `DEPLOY.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: the exact wire shapes and errors implemented in Tasks 2–4.
- Produces: parseable server protocol examples and a self-contained document that UCLI developers can execute without access to this conversation or server source.

- [ ] **Step 1: Write failing documentation contract assertions**

In `test/auth/device-grant-protocol.test.ts`, add `docs/ucli-client-model-protocol-upgrade.md` to the read set. Update the Bootstrap JSON expectation to require:

```ts
models: [{
  id: 'example-model', displayName: '示例模型', contextSize: 128000,
  protocols: ['openai_responses']
}]
```

Parse a new `### Gateway 路由错误响应` JSON block and assert the exact `statusCode`, `code`, `message`, `requestId`, and `retryable` fields. Assert both documents contain all four protocol values, all three 503 codes, `X-UCLI-Request-ID`, `Cache-Control: no-store`, prohibition of `models[0]`, and the required handoff YAML keys.

- [ ] **Step 2: Run the documentation contract and confirm the red state**

```powershell
npx vitest run test/auth/device-grant-protocol.test.ts
```

Expected: FAIL because the protocol and client handoff have not been updated.

- [ ] **Step 3: Update the authoritative protocol document**

In `docs/ucli-client-protocol.md`:

- add required `protocols` to the Bootstrap example;
- document the Gateway model list extension fields;
- add the exact 503 response block from the spec;
- state that `protocols` is static configured capability, not instantaneous health;
- require UCLI to select by protocol and never use `models[0]` as a protocol assumption;
- preserve the standalone-client degradation and authorization-expiry rules.

- [ ] **Step 4: Create the standalone UCLI implementation handoff**

Create `docs/ucli-client-model-protocol-upgrade.md` with these mandatory sections and decisions:

````markdown
# UCLI 客户端模型协议能力升级方案

## 实施仓库与边界
客户端代码只在 UCLI 仓库实施；UCLI Server 仓库不包含客户端代码改动。

## 服务端合同
- Bootstrap model.protocols is required.
- Gateway model list publishes protocols, display_name, and context_size.
- Exact protocol enum and three 503 error payloads.

## 客户端实现
- Parse and validate required protocols.
- Build provider/model choices by capability.
- Never infer from model ID/manufacturer and never fall back to models[0].
- Preserve standalone mode and credentials on protocol-route failure.
- Capture sanitized HTTP diagnostics before asserting stream success.

## 测试矩阵
- Contract fixtures for all protocols and missing/unknown values.
- Provider selection for Responses, Chat, Anthropic, and Gemini.
- Empty-compatible-model behavior.
- Three stable 503 failures and retryable semantics.
- Live model stream and cleanup.

## 回传格式
```yaml
timestamp: null
clientVersion: null
clientCommit: null
serverCommit: null
serverRuntimeImage: null
localContractGate: null
selectedModelId: "not-selected"
selectedProtocol: "not-selected"
failedStage: null
httpStatus: "not-received"
contentType: "not-received"
cacheControl: "not-received"
stableCode: "not-received"
requestId: "not-received"
retryable: null
streamReceivedNonEmptyData: false
authorizationExpiresAt: "not-recorded"
serverTimePresent: false
skillsCatalog: "NOT_RUN"
skillDownloadHash: "NOT_RUN"
cleanup: "NOT_RUN"
```

## 禁止回传内容
Connection URL, fragment, tokens, Authorization/Cookie, supplier keys, bodies, full headers, real user identity, and complete stack traces.
````

Replace the English shorthand in the final document with clear Chinese explanations while preserving every exact field and enum above.

- [ ] **Step 5: Update operator and release documentation**

Add this operator statement to `README.md`:

```markdown
服务端模型目录通过 `protocols` 声明每个模型可调用的 Gateway 协议。UCLI 必须按 `openai_responses`、`openai_chat`、`anthropic_messages` 或 `gemini` 能力选择模型和端点，不能假设列表首个模型支持 Responses。
```

Add this deployment rule under `DEPLOY.md` configuration guidance:

```markdown
Responses 客户端上线前，平台管理员必须创建独立的 `OPENAI_RESPONSES` 通道和模型映射，使用供应商 Responses API 对应的 base URL，并在管理端重新输入供应商密钥。不得复用带 `/anthropic` 的 Anthropic Messages base URL，也不得从数据库或现有通道提取密钥。模型测试通过且价格有效后才能启用映射。
```

Add this release entry under `CHANGELOG.md` `Unreleased`:

```markdown
- 模型目录新增稳定的 Gateway 协议能力列表；Bootstrap 与 Gateway 模型列表保持一致，并用 `model_protocol_unavailable`、`model_channel_unavailable`、`upstream_unavailable` 区分路由失败。
- 新增独立 UCLI 模型协议能力升级交接文档；客户端不再假设模型列表首项支持 Responses。
```

- [ ] **Step 6: Run documentation and focused server contracts**

```powershell
npx vitest run test/auth/device-grant-protocol.test.ts test/catalog/catalog-runtime-isolation.test.ts test/gateway/model-capabilities.test.ts test/gateway/gateway.controller.test.ts test/gateway/gateway.service.test.ts
git diff --check
```

Expected: all focused tests PASS; `git diff --check` has no output.

- [ ] **Step 7: Commit protocol and handoff documents**

```powershell
git add -- docs/ucli-client-protocol.md docs/ucli-client-model-protocol-upgrade.md test/auth/device-grant-protocol.test.ts README.md DEPLOY.md CHANGELOG.md
git diff --cached --check
git commit -m "docs(client): publish model protocol upgrade handoff"
```

---

### Task 6: Run the Release Gate and Record Implementation Evidence

**Files:**

- Modify after successful verification: `docs/superpowers/plans/2026-08-28-model-protocol-capabilities.md`

**Interfaces:**

- Consumes: all implementation commits from Tasks 1–5.
- Produces: a clean, fully verified server branch and exact evidence for packaging/deployment; no production secret or client code is required.

- [ ] **Step 1: Run the complete focused regression set**

```powershell
npx vitest run `
  test/gateway/model-capabilities.test.ts `
  test/gateway/protocol.test.ts `
  test/gateway/relay.test.ts `
  test/gateway/gateway.service.test.ts `
  test/gateway/gateway.controller.test.ts `
  test/catalog/catalog-runtime-isolation.test.ts `
  test/auth/device-grant-client-metadata.test.ts `
  test/auth/device-grant-auth-matrix.test.ts `
  test/auth/device-grant-protocol.test.ts
```

Expected: every listed test file passes with zero failures and zero skips.

- [ ] **Step 2: Run the full repository release gate**

```powershell
npm run verify
```

Expected: typecheck, coverage suite, server build, admin build, and license check all exit 0. Record only test counts, coverage summary, and artifact success; do not copy environment values or request data.

- [ ] **Step 3: Inspect the final diff and commit graph**

```powershell
git status --short
git diff --check
git log --oneline --decorate -8
git diff origin/codex/device-grant-link-implementation...HEAD --stat
```

Expected: only this plan is modified for evidence; no unexpected source, generated build output, environment file, archive, or credential is present.

- [ ] **Step 4: Append exact verification evidence to this plan**

Append an `## Implementation Evidence` section. Record the source SHA returned by `git rev-parse --short HEAD`, the exact focused-test pass/total counts, and the exact full-suite test count and coverage summary printed by `npm run verify`. Finish the section with these three literal statements:

```markdown
- Database migration: none
- Client implementation: NOT PERFORMED in this repository; handoff document generated
- Production Responses route: NOT CONFIGURED by code; administrator action required before live smoke
```

Do not write an evidence line until its command has completed successfully, and do not use example or placeholder values.

- [ ] **Step 5: Commit the verification record**

```powershell
git add -- docs/superpowers/plans/2026-08-28-model-protocol-capabilities.md
git diff --cached --check
git commit -m "docs(plan): record model protocol verification"
git status --short --branch
```

Expected: the final commit contains only verification evidence; the worktree is clean and the branch is ahead of its previous remote baseline.

---

## Post-Implementation Deployment Gate

Deployment and live smoke begin only after Task 6 is complete. They are intentionally not source implementation tasks because they require production administrator authority and a supplier secret that must not enter this repository.

1. Build/package and deploy the verified server commit using the existing `/data/ucli-server` release procedure.
2. Confirm `/healthz` and `/gateway/healthz` return HTTP 200 and record immutable runtime/web image digests.
3. In the platform UI, create a separate Responses channel with the supplier's Responses base URL, manually enter its key, create an `OPENAI_RESPONSES` mapping and valid price, run the model test, then enable the mapping/model.
4. With an existing device token, verify Bootstrap and `/gateway/v1/models` expose identical `protocols` and at least one model contains `openai_responses`.
5. Give `docs/ucli-client-model-protocol-upgrade.md` to the UCLI project and wait for its local contract results; do not create a new authorization before the client gate passes.
6. After the client gate passes, create one fresh device authorization and one fresh URL, run the complete live smoke exactly once, then correlate the client `requestId` with sanitized Gateway/usage evidence.
7. Disable the smoke authorization after joint acceptance. A consumed URL is never reused; a failed post-redeem rerun requires a new authorization.

## Joint Acceptance Criteria

- Bootstrap and Gateway model catalogs expose consistent, non-empty protocol arrays for usable configured models.
- No model without an enabled mapping/channel/key appears in either client catalog.
- Responses selection uses a model declaring `openai_responses`; no client path assumes `models[0]` supports Responses.
- Each route failure returns the documented code, request ID, retryability, JSON content type, and no-store cache policy.
- Protocol-incompatible and no-candidate failures do not reserve quota or call upstream.
- Upstream exhaustion retains usage and route attempt evidence with the same request ID returned to the client.
- Full server verification passes with no database migration.
- The UCLI handoff is self-contained and client implementation occurs only in the separate UCLI repository.
- Production Responses configuration is entered by an authorized administrator without extracting an existing encrypted key.
- A fresh post-upgrade authorization completes preview, redeem, idempotent redeem, refresh, bootstrap, models, model stream, skills catalog/download, and cleanup.

## Implementation Evidence

- Source SHA: `f966d60`
- Focused regression: 9 test files passed; 82/82 tests passed; 0 failures and 0 skips.
- Full repository suite: 85 test files passed and 1 skipped (86 total); 571 tests passed and 1 skipped (572 total).
- Coverage (all files): 94.29% statements, 86.77% branches, 91.66% functions, 94.29% lines.
- Release artifacts: TypeScript typecheck passed; server build passed; admin production build passed (690 modules transformed); license gate passed for 455 package records.
- An initial archive line-ending test timeout was non-reproducible in isolated diagnostics; the fresh clean `npm run verify` retry passed that test in 3019ms.
- Database migration: none
- Client implementation: NOT PERFORMED in this repository; handoff document generated
- Production Responses route: NOT CONFIGURED by code; administrator action required before live smoke
