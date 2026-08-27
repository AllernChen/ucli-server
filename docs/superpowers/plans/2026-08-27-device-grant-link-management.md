# Device Grant Link Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow every active account role to own a device grant while managing a separately expiring, recoverable, and safely rotatable connection URL for that stable grant.

**Architecture:** Use an expand-contract database migration to introduce `DeviceGrantLink` without breaking intermediate commits, then move create, management, Preview, and Redeem flows from grant secrets to link secrets. Store each current link secret as both a one-way hash and AES-256-GCM ciphertext, retain only hash/hint lifecycle evidence after revocation or consumption, and expose all URL operations through organization-scoped admin APIs and shared Vue components.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, Vue 3, Vitest, happy-dom, Docker Compose

**Spec:** `docs/superpowers/specs/2026-08-27-device-grant-link-management-design.md`

## Global Constraints

- `PLATFORM_ADMIN`, `ORG_ADMIN`, and `MEMBER` are all eligible grant targets only while account, membership, and organization are active.
- Only `PLATFORM_ADMIN` and `ORG_ADMIN` in the managed organization may create, view, or regenerate connection links.
- Authorization expiry and URL expiry are independent; authorization defaults to permanent and URL defaults to 7 days.
- URL expiry presets are 1 day, 7 days, 30 days, permanent, and a custom future cutoff.
- One grant may have at most one unrevoked, unconsumed link and may bind exactly one device.
- A current link secret is stored as a hash plus AES-256-GCM ciphertext under `MASTER_KEY`; plaintext must not appear in logs, audits, list responses, query strings, or retained DOM.
- Viewing returns the same current URL. Regeneration rotates the link secret, revokes the old URL immediately, clears its ciphertext, and does not change the grant ID or authorization expiry.
- Successful Redeem consumes the link and clears its ciphertext. The same installation ID may retry with the retained hash for 10 minutes; other retries return `link_consumed`.
- Bound, disabled, deleted, or expired grants cannot generate links.
- The protocol is breaking: accept only `#link=` and `{ "link": ... }`; do not preserve `#token=` or `{ "token": ... }` compatibility.
- UCLI client code is outside this repository; this repository must publish an exact standalone client upgrade contract.
- Every behavior change follows red-green-refactor and each task ends in an independently reviewable commit.

## File Map

**Create:**

- `prisma/migrations/202608270001_device_grant_links_expand/migration.sql` — add link storage, migrate legacy hashes to inert history, and enforce one current link.
- `prisma/migrations/202608270002_device_grant_links_contract/migration.sql` — remove legacy secret columns from grants after all callers move.
- `packages/security/src/device-grant-links.ts` — pure link lifecycle, credential creation, encryption, and recovery.
- `apps/api/src/device-grant-links.service.ts` — transactional initial-link, view, and regeneration operations.
- `apps/admin/src/components/LinkExpiryFields.vue` — reusable URL expiry selector.
- `apps/admin/src/components/DeviceGrantLinkActions.vue` — view/copy/regenerate behavior shared by both grant pages.
- `scripts/rehearse-device-grant-link-migration.ps1` — disposable PostgreSQL expand/contract and rollback rehearsal.
- `test/auth/device-grant-link-lifecycle.test.ts` — pure status, failure, and crypto contract.
- `test/auth/device-grant-link-schema.test.ts` — expand/contract migration and Prisma relation contract.
- `test/auth/device-grant-links.service.test.ts` — admin link creation, recovery, rotation, concurrency, and audit behavior.
- `test/admin/device-grant-link-actions.test.ts` — mounted link action behavior and secret cleanup.
- `test/admin/device-grant-list-components.test.ts` — mounted grouped-list integration.

**Modify:**

- `prisma/schema.prisma` — add then finalize `DeviceGrantLink` relations and remove grant secret columns.
- `apps/api/src/app.module.ts` — register `DeviceGrantLinksService`.
- `apps/api/src/device-grants.dto.ts` — split grant expiry, URL expiry, and public `link` input.
- `apps/api/src/device-grants.controller.ts` — expose view and regenerate endpoints with `no-store`.
- `apps/api/src/auth.controller.ts` — pass `link` into Preview/Redeem.
- `apps/api/src/device-grants.service.ts` — eligibility, initial link, public lookup/redeem, summaries, and link-safe audits.
- `apps/api/src/users.service.ts` — include latest link summaries for every role.
- `packages/security/src/auth.ts` — publish stable link failure codes where shared device authorization needs them.
- `apps/admin/src/device-grants.ts` — link types, labels, URL expiry helpers, and action availability.
- `apps/admin/src/views/UserDetail.vue` — all-role creation and link operations.
- `apps/admin/src/views/DeviceGrants.vue` — link state and shared actions in grouped management.
- `apps/admin/src/views/Connect.vue` — read `#link=`, preview it, and show both expiries.
- `apps/admin/src/device-grant-connect.ts` — link-fragment parsing and status messages.
- `test/auth/device-grants.service.test.ts` — all-role creation and link summary coverage.
- `test/auth/device-grant-redeem.test.ts` — link-based atomic redemption and idempotent retry.
- `test/auth/device-grant-auth-matrix.test.ts` — account/membership/organization/link failure matrix.
- `test/auth/device-grants.controller.test.ts` — admin route and cache header metadata.
- `test/auth/users.service.test.ts` — role-independent detail projections with latest link.
- `test/admin/device-grant-management.test.ts` — link expiry and action helper contracts.
- `test/admin/device-grant-components.test.ts` — actual creation button submission and secret lifecycle.
- `test/admin/device-grant-connect.test.ts` — fragment, Preview, status, and DOM leakage behavior.
- `test/admin/device-grant-views.test.ts` — remove obsolete one-time-only source assertions.
- `test/auth/device-grant-protocol.test.ts` — exact server/client JSON and HTTP contract.
- `docs/ucli-client-protocol.md` — authoritative `#link=` protocol.
- `docs/ucli-client-registration-upgrade.md` — standalone UCLI implementation guide.
- `README.md`, `DEPLOY.md`, `CHANGELOG.md` — operator behavior, migration boundary, and unreleased change notes.

---

### Task 1: Link Lifecycle Domain and Expand Migration

**Files:**
- Create: `packages/security/src/device-grant-links.ts`
- Create: `prisma/migrations/202608270001_device_grant_links_expand/migration.sql`
- Create: `test/auth/device-grant-link-lifecycle.test.ts`
- Create: `test/auth/device-grant-link-schema.test.ts`
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `DeviceGrantLinkStatus`, `DeviceGrantLinkFailure`, `deriveDeviceGrantLinkStatus(link, now)`, `deviceGrantLinkFailure(link, now)`, `createDeviceGrantLinkCredential(masterKey)`, and `revealDeviceGrantLinkSecret(encrypted, masterKey)`.
- Produces: Prisma `DeviceGrantLink` with relation fields `DeviceGrant.links` and `Account.createdDeviceGrantLinks`.

- [ ] **Step 1: Write failing lifecycle and crypto tests**

```ts
import { describe, expect, it } from 'vitest'
import { createDeviceGrantLinkCredential, deriveDeviceGrantLinkStatus, deviceGrantLinkFailure, revealDeviceGrantLinkSecret } from '../../packages/security/src/device-grant-links.js'

const key = Buffer.alloc(32, 7)
const link = (overrides = {}) => ({ revokedAt: null, consumedAt: null, expiresAt: null, ...overrides })

it('derives consumed, revoked, expired, and available in priority order', () => {
  const now = new Date('2026-08-27T00:00:00.000Z')
  expect(deriveDeviceGrantLinkStatus(link({ consumedAt: now, revokedAt: now }), now)).toBe('CONSUMED')
  expect(deriveDeviceGrantLinkStatus(link({ revokedAt: now }), now)).toBe('REVOKED')
  expect(deriveDeviceGrantLinkStatus(link({ expiresAt: now }), now)).toBe('EXPIRED')
  expect(deriveDeviceGrantLinkStatus(link(), now)).toBe('AVAILABLE')
  expect(deviceGrantLinkFailure(link({ expiresAt: now }), now)).toBe('link_expired')
})

it('stores a hash and ciphertext that recover the same high-entropy secret', () => {
  const created = createDeviceGrantLinkCredential(key)
  expect(created.secret.length).toBeGreaterThanOrEqual(32)
  expect(created.secretHash).not.toContain(created.secret)
  expect(revealDeviceGrantLinkSecret(created.secretEncrypted, key)).toBe(created.secret)
  expect(() => revealDeviceGrantLinkSecret(created.secretEncrypted, Buffer.alloc(32, 8))).toThrow()
})
```

- [ ] **Step 2: Run the new tests and verify the missing module/schema failures**

Run: `npx vitest run test/auth/device-grant-link-lifecycle.test.ts test/auth/device-grant-link-schema.test.ts`

Expected: FAIL because `device-grant-links.ts`, `DeviceGrantLink`, and both migrations do not exist.

- [ ] **Step 3: Implement the pure link domain**

```ts
import type { EncryptedSecret } from './envelope-crypto.js'
import { decryptSecret, encryptSecret } from './envelope-crypto.js'
import { createOpaqueToken, hashOpaqueToken, opaqueTokenHint } from './tokens.js'

export type DeviceGrantLinkStatus = 'CONSUMED' | 'REVOKED' | 'EXPIRED' | 'AVAILABLE'
export type DeviceGrantLinkFailure = 'link_consumed' | 'link_revoked' | 'link_expired'
export type DeviceGrantLinkLifecycle = { consumedAt: Date | null; revokedAt: Date | null; expiresAt: Date | null }

export function deriveDeviceGrantLinkStatus(link: DeviceGrantLinkLifecycle, now = new Date()): DeviceGrantLinkStatus {
  if (link.consumedAt) return 'CONSUMED'
  if (link.revokedAt) return 'REVOKED'
  if (link.expiresAt && link.expiresAt <= now) return 'EXPIRED'
  return 'AVAILABLE'
}

export function deviceGrantLinkFailure(link: DeviceGrantLinkLifecycle, now = new Date()): DeviceGrantLinkFailure | null {
  const status = deriveDeviceGrantLinkStatus(link, now)
  return status === 'AVAILABLE' ? null : `link_${status.toLowerCase()}` as DeviceGrantLinkFailure
}

export function createDeviceGrantLinkCredential(masterKey: Buffer): {
  secret: string; secretHash: string; secretHint: string; secretEncrypted: EncryptedSecret
} {
  const secret = createOpaqueToken()
  return { secret, secretHash: hashOpaqueToken(secret), secretHint: opaqueTokenHint(secret), secretEncrypted: encryptSecret(secret, masterKey) }
}

export function revealDeviceGrantLinkSecret(value: EncryptedSecret, masterKey: Buffer): string {
  return decryptSecret(value, masterKey)
}
```

Export the return shape as `DeviceGrantLinkCredential` so the API service can prepare one credential and use its hash/hint for the temporary expand-phase grant columns without generating a second secret.

- [ ] **Step 4: Add the expand-only Prisma model and SQL migration**

Add `DeviceGrantLink` with `secretHash String @unique`, `secretEncrypted Json?`, `secretHint`, lifecycle timestamps, creator relation, and `@@index([deviceGrantId, createdAt])`. Keep `DeviceGrant.tokenHash` and `DeviceGrant.tokenHint` during the expand phase. The SQL migration must create `device_grant_links`, populate every legacy grant as `CONSUMED` when bound or `REVOKED` when unbound, leave `secret_encrypted` null for migrated rows, and create:

```sql
CREATE UNIQUE INDEX "device_grant_links_one_current_per_grant"
ON "device_grant_links" ("device_grant_id")
WHERE "revoked_at" IS NULL AND "consumed_at" IS NULL;
```

- [ ] **Step 5: Generate Prisma Client and run focused tests**

Run: `npm run db:generate && npx vitest run test/auth/device-grant-link-lifecycle.test.ts test/auth/device-grant-link-schema.test.ts`

Expected: PASS, with the schema test proving the partial unique index, historical migration, nullable encrypted secret, and both relations.

- [ ] **Step 6: Commit the domain and expand migration**

```bash
git add packages/security/src/device-grant-links.ts prisma/schema.prisma prisma/migrations/202608270001_device_grant_links_expand test/auth/device-grant-link-lifecycle.test.ts test/auth/device-grant-link-schema.test.ts
git commit -m "feat: add device grant link lifecycle"
```

### Task 2: All-Role Grant Creation with Initial Link

**Files:**
- Create: `apps/api/src/device-grant-links.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/device-grants.dto.ts`
- Modify: `apps/api/src/device-grants.service.ts`
- Test: `test/auth/device-grant-links.service.test.ts`
- Test: `test/auth/device-grants.service.test.ts`

**Interfaces:**
- Consumes: `createDeviceGrantLinkCredential(masterKey)` from Task 1 and Prisma `DeviceGrantLink`.
- Produces: `DeviceGrantLinksService.createInTransaction(transaction, input): Promise<CreatedDeviceGrantLink>`.
- Produces: create response `{ id, expiresAt, currentLink, connectionUrl }` and request `{ expiresAt?: string | null, linkExpiresAt?: string | null }`.

- [ ] **Step 1: Write failing role and initial-link tests**

Add a table-driven service test that creates grants for `PLATFORM_ADMIN`, `ORG_ADMIN`, and `MEMBER`, then asserts one link row and an HTTP fragment:

```ts
for (const role of ['PLATFORM_ADMIN', 'ORG_ADMIN', 'MEMBER'] as const) {
  it(`creates an initial 7-day link for active ${role}`, async () => {
    state.membership.role = role
    const result = await service.create('org-1', 'actor-1', 'account-1', {})
    expect(result.connectionUrl).toMatch(/^http:\/\/10\.0\.0\.8:3000\/connect#link=/)
    expect(result.currentLink.expiresAt).toEqual(new Date('2026-09-03T00:00:00.000Z'))
    expect(calls.linkCreate).toHaveLength(1)
  })
}
```

Also assert account disabled, membership disabled, and organization disabled each reject before a grant or link is written.

- [ ] **Step 2: Run focused tests and verify they fail on the MEMBER-only guard and missing link service**

Run: `npx vitest run test/auth/device-grants.service.test.ts test/auth/device-grant-links.service.test.ts`

Expected: FAIL because admin roles are rejected and no link row/`#link=` URL exists.

- [ ] **Step 3: Extend DTOs with independent expiries**

```ts
export class CreateDeviceGrantDto {
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsDateString({ strict: true })
  expiresAt?: string | null

  @IsOptional() @ValidateIf((_, value) => value !== null) @IsDateString({ strict: true })
  linkExpiresAt?: string | null
}

export class CreateDeviceGrantLinkDto {
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsDateString({ strict: true })
  expiresAt?: string | null
}
```

Undefined `linkExpiresAt` must resolve to `now + 7 days`; `null` means permanent; strings must be future ISO timestamps.

- [ ] **Step 4: Implement transactional initial-link creation**

Register `DeviceGrantLinksService` in `AppModule`. Give it this exact internal interface:

```ts
export interface CreateLinkInTransactionInput {
  organizationId: string
  actorId: string
  grantId: string
  expiresAt: Date | null
  action: 'create' | 'regenerate'
  credential: DeviceGrantLinkCredential
}

prepareCredential(): DeviceGrantLinkCredential

async createInTransaction(
  transaction: Prisma.TransactionClient,
  input: CreateLinkInTransactionInput
): Promise<{ id: string; secret: string; secretHint: string; expiresAt: Date | null; createdAt: Date }>;
```

Load `MASTER_KEY` once when the service is constructed. `prepareCredential()` creates hash/ciphertext material from that key; `createInTransaction()` persists exactly the supplied credential and writes `device_grant_link.create` without secret/hash/ciphertext metadata.

- [ ] **Step 5: Remove role-based target rejection and create grant plus link atomically**

Select membership role/status, account status, and organization enabled. Reject only inactive state. During the expand phase, set legacy `tokenHash`/`tokenHint` to the same link hash/hint solely to satisfy existing non-null columns; no route may treat them as the final protocol after Task 4.

```ts
const credential = this.links.prepareCredential()
const created = await transaction.deviceGrant.create({ data: {
  organizationId, accountId, createdById: actorId, expiresAt,
  tokenHash: credential.secretHash, tokenHint: credential.secretHint
} })
const link = await this.links.createInTransaction(transaction, {
  organizationId, actorId, grantId: created.id, expiresAt: linkExpiresAt,
  action: 'create', credential
})
return { id: created.id, expiresAt, currentLink: serializeLink(link, now), connectionUrl: linkUrl(origin, link.secret) }
```

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm run typecheck && npx vitest run test/auth/device-grants.service.test.ts test/auth/device-grant-links.service.test.ts`

Expected: PASS for all three roles, independent expiries, default 7 days, permanent URLs, and inactive-state rejection.

- [ ] **Step 7: Commit initial-link creation**

```bash
git add apps/api/src/app.module.ts apps/api/src/device-grants.dto.ts apps/api/src/device-grants.service.ts apps/api/src/device-grant-links.service.ts test/auth/device-grants.service.test.ts test/auth/device-grant-links.service.test.ts
git commit -m "feat: create grants with recoverable links"
```

### Task 3: Admin View and Regenerate APIs

**Files:**
- Modify: `apps/api/src/device-grant-links.service.ts`
- Modify: `apps/api/src/device-grants.controller.ts`
- Test: `test/auth/device-grant-links.service.test.ts`
- Test: `test/auth/device-grants.controller.test.ts`

**Interfaces:**
- Consumes: `revealDeviceGrantLinkSecret`, current-link unique constraint, `CreateDeviceGrantLinkDto`.
- Produces: `viewCurrent(organizationId, actorId, grantId)` and `regenerate(organizationId, actorId, grantId, input)`.
- Produces: `GET /api/v1/admin/device-grants/:id/link` and `POST /api/v1/admin/device-grants/:id/links`.

- [ ] **Step 1: Write failing recovery, rotation, and concurrency tests**

```ts
it('returns the same URL without rotating it', async () => {
  const first = await links.viewCurrent('org-1', 'actor-1', 'grant-1')
  const second = await links.viewCurrent('org-1', 'actor-1', 'grant-1')
  expect(second.connectionUrl).toBe(first.connectionUrl)
  expect(calls.linkCreate).toHaveLength(0)
  expect(calls.audit.map(call => call.action)).toEqual(['device_grant_link.view', 'device_grant_link.view'])
})

it('revokes and clears the previous ciphertext before inserting one replacement', async () => {
  const result = await links.regenerate('org-1', 'actor-1', 'grant-1', { expiresAt: null })
  expect(result.connectionUrl).not.toBe(previousUrl)
  expect(state.previous.revokedAt).toBeInstanceOf(Date)
  expect(state.previous.secretEncrypted).toBeNull()
  expect(state.currentCount).toBe(1)
})
```

Add cases for wrong organization, bound/disabled/deleted/expired grants, missing ciphertext, wrong master key, expired-link viewing, and two concurrent regenerations leaving exactly one current link.

- [ ] **Step 2: Run tests and verify missing methods/routes fail**

Run: `npx vitest run test/auth/device-grant-links.service.test.ts test/auth/device-grants.controller.test.ts`

Expected: FAIL because view/regenerate methods and route metadata are absent.

- [ ] **Step 3: Implement organization-scoped view**

Lock nothing for a read, but query grant by `id`, `organizationId`, and latest link. Permit link states `AVAILABLE` and `EXPIRED` only when ciphertext exists, even if the grant later became disabled or expired; this matches the approved recovery API, while the UI exposes the action only for an AVAILABLE unbound grant. Decrypt, construct `#link=`, write a `device_grant_link.view` audit with only IDs/hint/status, and return a response whose controller adds `Cache-Control: no-store`.

- [ ] **Step 4: Implement serialized regeneration**

Inside one Prisma transaction:

```sql
SELECT "id" FROM "device_grants"
WHERE "id" = $1::uuid AND "organization_id" = $2::uuid
FOR UPDATE;
```

Re-read lifecycle, require grant status `AVAILABLE`, update every unrevoked/unconsumed link with `{ revokedAt: now, secretEncrypted: null }`, insert exactly one new link, and audit `device_grant_link.regenerate` with `previousLinkId` and `newLinkId` but no secrets.

- [ ] **Step 5: Add controller routes and cache metadata**

Inject `DeviceGrantLinksService` into `DeviceGrantsController` alongside the existing grant service, then add:

```ts
@Get('device-grants/:id/link')
@Header('Cache-Control', 'no-store')
viewLink(@Req() req: any, @Param('id', UuidPipe) id: string) {
  return this.links.viewCurrent(req.principal.organizationId, req.principal.sub, id)
}

@Post('device-grants/:id/links')
@Header('Cache-Control', 'no-store')
regenerateLink(@Req() req: any, @Param('id', UuidPipe) id: string, @Body() body: CreateDeviceGrantLinkDto) {
  return this.links.regenerate(req.principal.organizationId, req.principal.sub, id, body)
}
```

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm run typecheck && npx vitest run test/auth/device-grant-links.service.test.ts test/auth/device-grants.controller.test.ts`

Expected: PASS, including `no-store`, audit redaction, organization isolation, ciphertext cleanup, and concurrency.

- [ ] **Step 7: Commit admin link management**

```bash
git add apps/api/src/device-grant-links.service.ts apps/api/src/device-grants.controller.ts test/auth/device-grant-links.service.test.ts test/auth/device-grants.controller.test.ts
git commit -m "feat: view and regenerate grant links"
```

### Task 4: Link-Based Preview and Atomic Redeem

**Files:**
- Modify: `apps/api/src/device-grants.dto.ts`
- Modify: `apps/api/src/auth.controller.ts`
- Modify: `apps/api/src/device-grants.service.ts`
- Modify: `packages/security/src/auth.ts`
- Test: `test/auth/device-grant-redeem.test.ts`
- Test: `test/auth/device-grant-auth-matrix.test.ts`
- Test: `test/auth/device-grant-auth.test.ts`

**Interfaces:**
- Consumes: `deviceGrantLinkFailure`, link hash lookup, all-role eligibility, and the existing 10-minute `redeemRetryUntil`.
- Produces: Preview/Redeem bodies with `link`, stable link errors, dual expiry response, and same-installation idempotent retry.

- [ ] **Step 1: Rewrite public-contract tests to fail on the legacy token path**

```ts
await expect(service.preview(linkSecret)).resolves.toMatchObject({
  link: { status: 'AVAILABLE', expiresAt: linkExpiresAt },
  authorization: { status: 'AVAILABLE', expiresAt: grantExpiresAt }
})

await expect(service.redeem({ link: oldSecret, device: secondDevice })).rejects.toMatchObject({
  response: { code: 'link_consumed' }
})
```

Cover `invalid_link`, `link_expired`, `link_revoked`, `link_consumed`, grant lifecycle failures, every active role, organization/account/membership disablement, simultaneous first Redeem, same-installation retry inside 10 minutes, retry after 10 minutes, and a different installation ID.

- [ ] **Step 2: Run public auth tests and verify they fail on `{ token }` and grant-table lookup**

Run: `npx vitest run test/auth/device-grant-redeem.test.ts test/auth/device-grant-auth-matrix.test.ts test/auth/device-grant-auth.test.ts`

Expected: FAIL because DTOs/controllers/services still read `token` and `device_grants.token_hash`.

- [ ] **Step 3: Change DTOs and controller to the breaking `link` field**

```ts
export class PreviewDeviceGrantDto { @Allow() link!: unknown }
export class RedeemDeviceGrantDto extends PreviewDeviceGrantDto { @Allow() device!: unknown }
```

`AuthController.preview` and `redeem` must pass `body.link`; no alias or fallback reads `body.token`.

- [ ] **Step 4: Implement Preview through link hash**

Validate secret shape, hash it, include link → grant → account/organization, derive link failure first, then authorization/account/membership/organization failure. Return:

```ts
{
  account: { id, displayName },
  organization: { id, name },
  link: { status, expiresAt },
  authorization: { status, expiresAt, serverTime: now.toISOString() }
}
```

- [ ] **Step 5: Implement locked first Redeem and consumption**

Lock `device_grant_links` by `secret_hash`, then lock/read its grant in the same transaction. On first bind, create the device, bind the grant, set `consumedAt`, clear `secretEncrypted`, retain `secretHash`, and issue credentials. Preserve installation conflict handling and audit only `secretHint`.

- [ ] **Step 6: Preserve safe idempotent retry**

If the link is `CONSUMED`, allow retry only when the grant device has the same `installationId`, the device is active, and `redeemRetryUntil > now`. Rotate only that device's refresh token and return credentials; do not create or rebind a device. Otherwise throw `{ code: 'link_consumed' }`.

- [ ] **Step 7: Run focused tests and typecheck**

Run: `npm run typecheck && npx vitest run test/auth/device-grant-redeem.test.ts test/auth/device-grant-auth-matrix.test.ts test/auth/device-grant-auth.test.ts`

Expected: PASS with exactly one first bind under concurrency and no legacy token acceptance.

- [ ] **Step 8: Commit the public link protocol**

```bash
git add apps/api/src/device-grants.dto.ts apps/api/src/auth.controller.ts apps/api/src/device-grants.service.ts packages/security/src/auth.ts test/auth/device-grant-redeem.test.ts test/auth/device-grant-auth-matrix.test.ts test/auth/device-grant-auth.test.ts
git commit -m "feat: redeem devices through grant links"
```

### Task 5: Link Summaries and Contract Migration

**Files:**
- Create: `prisma/migrations/202608270002_device_grant_links_contract/migration.sql`
- Modify: `prisma/schema.prisma`
- Modify: `apps/api/src/device-grants.service.ts`
- Modify: `apps/api/src/users.service.ts`
- Test: `test/auth/device-grant-link-schema.test.ts`
- Test: `test/auth/device-grants.service.test.ts`
- Test: `test/auth/users.service.test.ts`

**Interfaces:**
- Consumes: `deriveDeviceGrantLinkStatus` and completed link-based public flows.
- Produces: `currentLink: { id, secretHint, status, expiresAt, createdAt } | null` on grant summaries.
- Removes: Prisma and SQL fields `DeviceGrant.tokenHash` and `DeviceGrant.tokenHint`.

- [ ] **Step 1: Write failing list/detail projection tests**

```ts
expect(result.deviceGrants[0]).toMatchObject({
  id: 'grant-1',
  currentLink: { id: 'link-2', secretHint: '…abcd', status: 'EXPIRED', expiresAt: linkExpiry }
})
expect(result.deviceGrants[0]).not.toHaveProperty('tokenHash')
expect(result.deviceGrants[0]).not.toHaveProperty('tokenHint')
```

Assert the latest link is returned for consumed/revoked history, no secret ciphertext/hash is serialized, and all three account roles appear in user detail.

- [ ] **Step 2: Run projection/schema tests and verify legacy-field failures**

Run: `npx vitest run test/auth/device-grant-link-schema.test.ts test/auth/device-grants.service.test.ts test/auth/users.service.test.ts`

Expected: FAIL because summaries still read grant `tokenHint` and contract migration is absent.

- [ ] **Step 3: Replace grant projections with latest-link projections**

Every grant query selects:

```ts
links: {
  orderBy: { createdAt: 'desc' }, take: 1,
  select: { id: true, secretHint: true, expiresAt: true, revokedAt: true, consumedAt: true, createdAt: true }
}
```

Serialize the first link as `currentLink` using `deriveDeviceGrantLinkStatus`. Do not select `secretHash` or `secretEncrypted` in list/detail paths.

- [ ] **Step 4: Remove legacy secret usage from audits and failure paths**

Use the locked or latest link's `secretHint` for safe audit context. Scan production TypeScript with:

Run: `rg -n "tokenHash|tokenHint|token_hash|token_hint" apps packages prisma/schema.prisma`

Expected before the contract migration: matches only `prisma/schema.prisma`; no application code references legacy grant fields.

- [ ] **Step 5: Add the contract migration and finalize Prisma schema**

The SQL migration must fail closed if any grant lacks at least one historical/current link, then drop both columns:

```sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "device_grants" g
    WHERE NOT EXISTS (SELECT 1 FROM "device_grant_links" l WHERE l."device_grant_id" = g."id")
  ) THEN
    RAISE EXCEPTION 'device grant link backfill incomplete';
  END IF;
END $$;

ALTER TABLE "device_grants" DROP COLUMN "token_hash", DROP COLUMN "token_hint";
```

Remove both fields from `DeviceGrant` in `schema.prisma`.

- [ ] **Step 6: Generate client and run focused tests**

Run: `npm run db:generate && npm run typecheck && npx vitest run test/auth/device-grant-link-schema.test.ts test/auth/device-grants.service.test.ts test/auth/users.service.test.ts`

Expected: PASS and no production `tokenHash`/`tokenHint` reference remains.

- [ ] **Step 7: Commit projections and contract migration**

```bash
git add prisma/schema.prisma prisma/migrations/202608270002_device_grant_links_contract apps/api/src/device-grants.service.ts apps/api/src/users.service.ts test/auth/device-grant-link-schema.test.ts test/auth/device-grants.service.test.ts test/auth/users.service.test.ts
git commit -m "refactor: separate grant and link records"
```

### Task 6: Admin Link Types and Expiry Selector

**Files:**
- Create: `apps/admin/src/components/LinkExpiryFields.vue`
- Modify: `apps/admin/src/device-grants.ts`
- Modify: `test/admin/device-grant-management.test.ts`
- Test: `test/admin/device-grant-components.test.ts`

**Interfaces:**
- Produces: `DeviceGrantLinkSummary`, `LinkExpiryMode`, `LinkExpiryForm`, `linkExpiryPayload(form, now)`, `linkStatusLabel(status)`, and `LinkExpiryFields` `v-model`.

- [ ] **Step 1: Write failing expiry and mounted selector tests**

```ts
const now = new Date('2026-08-27T00:00:00.000Z')
expect(linkExpiryPayload({ mode: '7d', customExpiresAt: '' }, now)).toEqual({ expiresAt: '2026-09-03T00:00:00.000Z' })
expect(linkExpiryPayload({ mode: 'permanent', customExpiresAt: '' }, now)).toEqual({ expiresAt: null })
expect(() => linkExpiryPayload({ mode: 'custom', customExpiresAt: '' }, now)).toThrow('请选择 URL 有效期')
```

Mount `LinkExpiryFields`, select each preset, and assert the custom datetime field is required and enabled only for `custom`.

- [ ] **Step 2: Run focused admin tests and verify missing helpers/component**

Run: `npx vitest run test/admin/device-grant-management.test.ts test/admin/device-grant-components.test.ts`

Expected: FAIL because link types and expiry selector do not exist.

- [ ] **Step 3: Add link types and pure expiry helpers**

```ts
export type DeviceGrantLinkStatus = 'AVAILABLE' | 'EXPIRED' | 'REVOKED' | 'CONSUMED'
export type LinkExpiryMode = '1d' | '7d' | '30d' | 'permanent' | 'custom'
export interface LinkExpiryForm { mode: LinkExpiryMode; customExpiresAt: string }
export interface DeviceGrantLinkSummary {
  id: string; secretHint: string; status: DeviceGrantLinkStatus; expiresAt: string | null; createdAt: string
}
```

`linkExpiryPayload` must use exact millisecond durations from the supplied `now`, convert custom local datetime to ISO, and reject past/invalid custom values.

- [ ] **Step 4: Implement the reusable selector**

`LinkExpiryFields.vue` receives `modelValue: LinkExpiryForm`, emits `update:modelValue`, labels the select `URL 有效期`, and exposes options `1 天`, `7 天（默认）`, `30 天`, `永久`, `自定义`. It must not compute or retain a secret.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run test/admin/device-grant-management.test.ts test/admin/device-grant-components.test.ts`

Expected: PASS for every preset, fixed-time calculation, custom validation, labels, and field enablement.

- [ ] **Step 6: Commit admin expiry primitives**

```bash
git add apps/admin/src/device-grants.ts apps/admin/src/components/LinkExpiryFields.vue test/admin/device-grant-management.test.ts test/admin/device-grant-components.test.ts
git commit -m "feat: add grant link expiry controls"
```

### Task 7: Shared View, Copy, and Regenerate Component

**Files:**
- Create: `apps/admin/src/components/DeviceGrantLinkActions.vue`
- Create: `test/admin/device-grant-link-actions.test.ts`
- Modify: `apps/admin/src/device-grants.ts`

**Interfaces:**
- Consumes: `DeviceGrantSummary`, `LinkExpiryFields`, `linkExpiryPayload`, admin link endpoints, and `createExclusiveAsyncRequestGate`.
- Produces: `<DeviceGrantLinkActions :grant="grant" @changed="load" />`.

- [ ] **Step 1: Write failing mounted action tests with real clicks**

Mount the component with an AVAILABLE unbound grant. Click `查看 URL`, resolve the mocked GET, and assert a drawer contains the URL. Close it and assert the secret is absent from `document.body.textContent`. Click `重新生成 URL`, confirm the warning text, select 30 days, submit, and assert:

```ts
expect(state.api).toHaveBeenLastCalledWith('/api/v1/admin/device-grants/grant-1/links', {
  method: 'POST', body: JSON.stringify({ expiresAt: '2026-09-26T00:00:00.000Z' })
})
expect(wrapper.emitted('changed')).toHaveLength(1)
```

Add tests for copy success/failure, API errors, duplicate-click exclusion, unmount during requests, and no view/regenerate buttons for bound/disabled/deleted/expired grants. An expired URL under an otherwise AVAILABLE grant must remain viewable and regeneratable.

- [ ] **Step 2: Run the component test and verify the component is missing**

Run: `npx vitest run test/admin/device-grant-link-actions.test.ts`

Expected: FAIL because `DeviceGrantLinkActions.vue` does not exist.

- [ ] **Step 3: Implement action availability as pure helpers**

Add helpers that distinguish grant lifecycle from link lifecycle:

```ts
export function canViewGrantLink(grant: DeviceGrantSummary) {
  return grant.status === 'AVAILABLE' && grant.deviceId === null &&
    ['AVAILABLE', 'EXPIRED'].includes(grant.currentLink?.status || '')
}
export function canRegenerateGrantLink(grant: DeviceGrantSummary) {
  return grant.status === 'AVAILABLE' && grant.deviceId === null
}
```

- [ ] **Step 4: Implement the shared component**

Use GET for view and POST for regeneration, `Cache-Control` behavior from the server, `createExclusiveAsyncRequestGate` for each mutation path, and `createRequestLifecycle` to suppress secrets after unmount. Keep recovered/generated URLs only in a `ref`, clear it on close and unmount, and display every caught error beside the relevant action.

- [ ] **Step 5: Run mounted tests**

Run: `npx vitest run test/admin/device-grant-link-actions.test.ts test/admin/device-grant-management.test.ts`

Expected: PASS with real button clicks, secret cleanup, no duplicate POST, and visible failures.

- [ ] **Step 6: Commit shared link actions**

```bash
git add apps/admin/src/components/DeviceGrantLinkActions.vue apps/admin/src/device-grants.ts test/admin/device-grant-link-actions.test.ts test/admin/device-grant-management.test.ts
git commit -m "feat: manage grant links in admin UI"
```

### Task 8: User Detail Creation and Link Management

**Files:**
- Modify: `apps/admin/src/views/UserDetail.vue`
- Modify: `test/admin/device-grant-components.test.ts`
- Modify: `test/admin/device-grant-views.test.ts`

**Interfaces:**
- Consumes: `LinkExpiryFields`, `DeviceGrantLinkActions`, `linkExpiryPayload`, and backend `currentLink` summaries.
- Produces: all-role grant creation with independent authorization/URL expiry controls and durable post-close recovery actions.

- [ ] **Step 1: Write a failing real-click creation test**

Mount `UserDetail` with each of the three roles, click the page `创建授权` button, leave authorization permanent, leave URL at 7 days, and click the actual drawer footer submit button. Assert the POST body includes both fields and the success drawer appears:

```ts
expect(state.api).toHaveBeenLastCalledWith('/api/v1/admin/users/user-1/device-grants', {
  method: 'POST',
  body: JSON.stringify({ expiresAt: null, linkExpiresAt: '2026-09-03T00:00:00.000Z' })
})
expect(document.body.textContent).toContain('以后仍可在授权列表中查看当前 URL')
```

Assert a disabled membership shows a visible reason and no silent disabled control. Replace obsolete assertions that claim the secret can never be viewed again.

- [ ] **Step 2: Run user-detail tests and verify PLATFORM_ADMIN/ORG_ADMIN and payload failures**

Run: `npx vitest run test/admin/device-grant-components.test.ts test/admin/device-grant-views.test.ts`

Expected: FAIL because `canCreateGrant` is MEMBER-only and the form has no URL expiry.

- [ ] **Step 3: Allow every active role and submit both expiries**

Change `canCreateGrant` to membership status only. Keep the backend authoritative for account/organization status. Add a 7-day `LinkExpiryForm`, reset it on open/route change, and map it to `linkExpiresAt` in the create request.

- [ ] **Step 4: Render current link summaries and shared actions**

Replace the old grant token hint column with current link hint/status/expiry. Render `<DeviceGrantLinkActions>` for every grant and reload detail on `changed`. Update success copy to say the URL can be viewed later; still clear plaintext state on drawer close/unmount.

- [ ] **Step 5: Run mounted tests**

Run: `npx vitest run test/admin/device-grant-components.test.ts test/admin/device-grant-views.test.ts test/admin/device-grant-link-actions.test.ts`

Expected: PASS for all roles, actual submit-button behavior, independent expiries, late-response suppression, and post-close recovery.

- [ ] **Step 6: Commit user-detail integration**

```bash
git add apps/admin/src/views/UserDetail.vue test/admin/device-grant-components.test.ts test/admin/device-grant-views.test.ts
git commit -m "feat: create and manage links from user details"
```

### Task 9: Grouped Grant Management Integration

**Files:**
- Modify: `apps/admin/src/views/DeviceGrants.vue`
- Create: `test/admin/device-grant-list-components.test.ts`
- Modify: `test/admin/device-grant-views.test.ts`

**Interfaces:**
- Consumes: `DeviceGrantLinkActions` and `DeviceGrantSummary.currentLink`.
- Produces: grouped list columns for link status/expiry/hint plus view/copy/regenerate actions.

- [ ] **Step 1: Write a failing mounted grouped-list test**

Mock the grouped GET with AVAILABLE, EXPIRED-link, and BOUND grants. Assert rendered labels and click the nested shared action for the AVAILABLE grant. Verify user-row navigation is not triggered by action clicks and the list reloads after regeneration.

- [ ] **Step 2: Run the grouped-list test and verify missing columns/actions**

Run: `npx vitest run test/admin/device-grant-list-components.test.ts test/admin/device-grant-views.test.ts`

Expected: FAIL because the page still renders grant `tokenHint` and only lifecycle actions.

- [ ] **Step 3: Integrate link summaries and actions**

Add table columns `URL 提示`, `URL 状态`, and `URL 有效期`; render `未生成` when `currentLink` is null. Add `<DeviceGrantLinkActions :grant="grant" @changed="load" />` inside the operation cell without removing enable/disable/authorization-expiry/delete controls.

- [ ] **Step 4: Run mounted and helper tests**

Run: `npx vitest run test/admin/device-grant-list-components.test.ts test/admin/device-grant-views.test.ts test/admin/device-grant-link-actions.test.ts`

Expected: PASS for grouping, navigation isolation, all link states, and reload-after-change.

- [ ] **Step 5: Commit grouped-list integration**

```bash
git add apps/admin/src/views/DeviceGrants.vue test/admin/device-grant-list-components.test.ts test/admin/device-grant-views.test.ts
git commit -m "feat: expose link lifecycle in grant list"
```

### Task 10: Browser Connection Page and Client Contract

**Files:**
- Modify: `apps/admin/src/device-grant-connect.ts`
- Modify: `apps/admin/src/views/Connect.vue`
- Modify: `test/admin/device-grant-connect.test.ts`
- Modify: `test/auth/device-grant-protocol.test.ts`
- Modify: `docs/ucli-client-protocol.md`
- Modify: `docs/ucli-client-registration-upgrade.md`

**Interfaces:**
- Consumes: public Preview/Redeem `{ link }` contract and stable link failure codes.
- Produces: browser-to-UCLI handoff containing `#link=`, dual expiry display, and exact standalone client implementation instructions.

- [ ] **Step 1: Rewrite failing fragment and protocol tests**

```ts
expect(readGrantLink('#link=secret')).toBe('secret')
expect(readGrantLink('#token=legacy')).toBe('')
expect(protocol).toContain('http://10.0.0.8:3000/connect#link=one-time-link-secret')
expect(jsonBlock('Preview 请求')).toEqual({ link: '<secret>' })
expect(jsonBlock('Redeem 请求')).toMatchObject({ link: '<secret>' })
expect(clientUpgrade).toContain('link_expired')
expect(clientUpgrade).toContain('link_revoked')
expect(clientUpgrade).toContain('link_consumed')
```

- [ ] **Step 2: Run connection/protocol tests and verify legacy contract failures**

Run: `npx vitest run test/admin/device-grant-connect.test.ts test/auth/device-grant-protocol.test.ts`

Expected: FAIL on `#token=`, `{ token }`, one-expiry preview, and missing link error guidance.

- [ ] **Step 3: Update fragment parsing and Preview request**

Rename the parser to `readGrantLink`, accept only fragment key `link`, immediately remove the fragment with `history.replaceState`, POST `{ link }`, and keep the secret out of component refs after navigation/unmount.

- [ ] **Step 4: Update the connection view**

Display URL expiry separately from authorization expiry and preserve server time. Map stable link failures to concise instructions to contact an administrator for a new URL. Build the UCLI custom-protocol URL with `#link=` and the normalized server origin.

- [ ] **Step 5: Rewrite both client documents as exact implementation contracts**

Document the breaking field names, JSON examples, cache rules, link/authorization expiry distinction, error mapping, no persistent storage of link secret after Redeem, and the 10-minute same-installation retry. State that UCLI code is implemented in its own repository.

- [ ] **Step 6: Run contract tests**

Run: `npx vitest run test/admin/device-grant-connect.test.ts test/auth/device-grant-protocol.test.ts`

Expected: PASS with no `#token=` or public `{ token }` fallback.

- [ ] **Step 7: Commit connection and client contract**

```bash
git add apps/admin/src/device-grant-connect.ts apps/admin/src/views/Connect.vue test/admin/device-grant-connect.test.ts test/auth/device-grant-protocol.test.ts docs/ucli-client-protocol.md docs/ucli-client-registration-upgrade.md
git commit -m "docs: publish grant link client contract"
```

### Task 11: Operator Documentation, Migration Rehearsal, and Full Verification

**Files:**
- Create: `scripts/rehearse-device-grant-link-migration.ps1`
- Modify: `README.md`
- Modify: `DEPLOY.md`
- Modify: `CHANGELOG.md`
- Modify: `test/auth/device-grant-protocol.test.ts`
- Modify: `test/deploy/archive-line-endings.test.ts` only if new documented archive paths require it

**Interfaces:**
- Consumes: completed schema, APIs, UI, protocol, and both migrations.
- Produces: an unreleased operator record, explicit backup/rollback procedure, and a fully verified implementation branch.

- [ ] **Step 1: Add failing documentation assertions for operational boundaries**

Extend the release contract test to require exact statements that URL and authorization expiries are independent, regenerated URLs invalidate the previous URL, encrypted URLs depend on `MASTER_KEY`, and rollback restores both database and images.

- [ ] **Step 2: Run the documentation contract test**

Run: `npx vitest run test/auth/device-grant-protocol.test.ts`

Expected: FAIL because README/DEPLOY/CHANGELOG do not describe the new link model.

- [ ] **Step 3: Update operator documentation**

Add an `Unreleased` CHANGELOG section. Update README workflows for all three roles, initial 7-day URL, view, regenerate, and bound-state behavior. Update DEPLOY with expand/contract migration ordering, fresh database backup, `MASTER_KEY` continuity, client incompatibility, and rollback requiring the matching database dump plus prior images.

- [ ] **Step 4: Run all focused device-grant tests**

Run:

```bash
npx vitest run test/auth/device-grant-link-lifecycle.test.ts test/auth/device-grant-link-schema.test.ts test/auth/device-grant-links.service.test.ts test/auth/device-grants.service.test.ts test/auth/device-grant-redeem.test.ts test/auth/device-grant-auth-matrix.test.ts test/auth/device-grant-protocol.test.ts test/auth/users.service.test.ts test/admin/device-grant-management.test.ts test/admin/device-grant-components.test.ts test/admin/device-grant-link-actions.test.ts test/admin/device-grant-list-components.test.ts test/admin/device-grant-connect.test.ts test/admin/device-grant-views.test.ts
```

Expected: PASS with no skipped device-grant tests.

- [ ] **Step 5: Rehearse migrations against an isolated PostgreSQL database**

Create `scripts/rehearse-device-grant-link-migration.ps1`. It must use the fixed container name `ucli-device-grant-link-migration-rehearsal`, fail on every non-zero Docker/psql exit, and implement these exact phases:

1. Start `postgres:17-alpine`, poll `pg_isready` for at most 30 seconds, and create `fresh` and `legacy` databases.
2. Define `Invoke-Migration($database, $path)` using `docker cp $path "${Container}:/tmp/migration.sql"` followed by `docker exec $Container psql -U postgres -d $database -v ON_ERROR_STOP=1 -f /tmp/migration.sql`; never concatenate SQL into a shell command.
3. Apply every sorted `prisma/migrations/*/migration.sql` file to `fresh`.
4. Apply migrations through `202608260001_device_grants` to `legacy`, then seed fixed UUID rows for one organization/account/membership, one device, one unbound grant, and one bound grant. Give the grants distinct hashes/hints and set the bound grant's `device_id`/`bound_at`.
5. Apply `202608270001_device_grant_links_expand` and `202608270002_device_grant_links_contract` to `legacy`.
6. Run PostgreSQL `DO` blocks whose `IF EXISTS` branches use `RAISE EXCEPTION` for the expected lifecycle rows, missing legacy columns, and current-link uniqueness. Run an intentionally failing transaction that creates a marker table, removes one migrated link, executes the same completeness guard, and then verify both the marker and deletion rolled back.
7. In `finally`, remove only the fixed container with `docker rm -f ucli-device-grant-link-migration-rehearsal`; do not touch any other container, image, volume, or database.

Run:

```powershell
pwsh -NoProfile -File scripts/rehearse-device-grant-link-migration.ps1
```

Assert:

- unbound legacy row becomes `REVOKED` history with null ciphertext;
- bound legacy row becomes `CONSUMED` history with null ciphertext;
- no grant lacks a link before contract migration;
- legacy columns are absent afterward;
- partial unique index rejects two current links;
- the migration transaction rolls back completely when the backfill completeness guard is intentionally violated.

Expected: exit code 0 and the script reports both fresh-install and legacy expand/contract paths verified.

- [ ] **Step 6: Run the repository release gate**

Run: `npm run verify`

Expected: 0 exit code for typecheck, coverage tests, server build, admin build, and license gate. Record the existing bundle-size and dependency-audit warnings separately; do not report them as passing checks.

- [ ] **Step 7: Verify secret and legacy-protocol absence**

Run:

```bash
rg -n "#token=|body\.token|input\.token|tokenHash|tokenHint|token_hash|token_hint" apps packages prisma/schema.prisma docs/ucli-client-protocol.md docs/ucli-client-registration-upgrade.md
rg -n "secretEncrypted|secretHash|connectionUrl" apps/api/src | sort
```

Expected: first command returns no production/protocol matches; second command is manually checked so list endpoints and audit metadata never select or serialize hashes/ciphertext/full URLs.

- [ ] **Step 8: Commit docs and verification-ready state**

```bash
git add README.md DEPLOY.md CHANGELOG.md scripts/rehearse-device-grant-link-migration.ps1 test/auth/device-grant-protocol.test.ts test/deploy/archive-line-endings.test.ts
git commit -m "docs: document grant link operations"
```

- [ ] **Step 9: Review the complete branch diff**

Run: `git diff --check && git status --short && git log --oneline --decorate -12`

Expected: no whitespace errors, clean worktree, and one focused commit per task. Compare the complete branch against `docs/superpowers/specs/2026-08-27-device-grant-link-management-design.md` before requesting code review or deployment.
