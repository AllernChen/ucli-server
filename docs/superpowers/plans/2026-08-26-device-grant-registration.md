# UCLI Device Grant Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace invitation acceptance and device-code approval with platform-created members and managed, one-device authorization links that register UCLI to one server.

**Architecture:** Add a persistent `DeviceGrant` between a member and a device. The browser previews an opaque grant and launches UCLI; UCLI redeems it once for normal access/refresh credentials, while every later authorization check evaluates the grant's current disabled, deleted, and expiry fields. Keep member management, grant management, public registration endpoints, and client-facing presentation in focused modules.

**Tech Stack:** TypeScript 5.9, NestJS 11, Prisma 6/PostgreSQL, Vue 3/Vue Router 4, class-validator, Vitest, Node crypto.

**Spec:** `docs/superpowers/specs/2026-08-26-device-grant-registration-design.md`

## Global Constraints

- UCLI remains independently usable without a server registration.
- One UCLI installation has at most one current server connection; client implementation is owned by the separate UCLI repository.
- New managed users are passwordless `MEMBER` accounts; existing administrators keep password login.
- One grant binds one device; one user may own multiple grants and devices.
- `expiresAt = null` means permanent authorization; expiry applies to both unused grants and bound devices.
- Disable is reversible; delete is an irreversible soft delete that permanently revokes the bound device.
- Raw grant and refresh tokens never appear in database output, logs, audit metadata, URL request paths, or error messages.
- `PUBLIC_URL` may be an HTTP IP-and-port origin because the approved deployment assumes a trusted company network.
- Remove the old invitation and device-code flows without a compatibility endpoint.
- Preserve accounts, memberships, organizations, quotas, usage history, audit history, and other non-authentication business data.

---

## File Structure

### New backend files

- `packages/security/src/device-grants.ts`: pure grant state derivation and stable authorization error mapping shared by API authentication paths.
- `apps/api/src/device-grants.dto.ts`: validated admin, preview, and redeem request/query contracts.
- `apps/api/src/users.service.ts`: managed member creation, listing, detail, disable, and enable behavior.
- `apps/api/src/users.controller.ts`: organization-scoped admin user routes.
- `apps/api/src/device-grants.service.ts`: grant creation, listing, lifecycle, preview, transactional redeem, and response serialization.
- `apps/api/src/device-grants.controller.ts`: organization-scoped admin grant routes.

### New admin files

- `apps/admin/src/device-grants.ts`: UI types, status/expiry formatting, filter construction, and grant action policy.
- `apps/admin/src/device-grant-connect.ts`: fragment parsing and exact `ucli://` URL construction.
- `apps/admin/src/views/Connect.vue`: public browser landing and UCLI launch page.
- `apps/admin/src/views/Users.vue`: member creation and paginated member list.
- `apps/admin/src/views/UserDetail.vue`: one member's grants and devices.
- `apps/admin/src/views/DeviceGrants.vue`: grants grouped and paginated by user.
- `apps/admin/src/device-grants.css`: focused styles for the three admin views and public connect card.

### New tests

- `test/auth/device-grant-schema.test.ts`
- `test/auth/device-grant-lifecycle.test.ts`
- `test/auth/users.service.test.ts`
- `test/auth/users.controller.test.ts`
- `test/auth/device-grants.service.test.ts`
- `test/auth/device-grants.controller.test.ts`
- `test/auth/device-grant-redeem.test.ts`
- `test/auth/device-grant-auth.test.ts`
- `test/auth/device-grant-client-metadata.test.ts`
- `test/admin/device-grant-connect.test.ts`
- `test/admin/device-grant-management.test.ts`
- `test/admin/device-grant-views.test.ts`
- `test/auth/device-grant-protocol.test.ts`

### Existing files to modify or remove

- `prisma/schema.prisma` and a new migration: persistence and destructive retirement of old auth tables.
- `packages/security/src/tokens.ts`: replace device-code generation with generic opaque grant generation and hints.
- `packages/security/src/auth.ts`: require an active grant for device principals.
- `apps/api/src/auth.service.ts`, `apps/api/src/auth.controller.ts`: remove old flows, add preview/redeem delegation, make password login null-safe, and enforce grants during refresh.
- `apps/api/src/client.controller.ts`: return current authorization metadata from bootstrap.
- `apps/api/src/app.module.ts`: register the new services/controllers.
- `apps/api/src/governance.controller.ts`: remove invitation/member/device responsibilities after they move to focused controllers.
- `apps/admin/src/api.ts`, `apps/admin/src/main.ts`, `apps/admin/src/App.vue`, `apps/admin/src/views/Governance.vue`: public API support, new routes/navigation, and removal of old governance UI.
- Delete `apps/admin/src/views/InviteAccept.vue` and `apps/admin/src/views/DeviceApproval.vue`.
- `docs/ucli-client-protocol.md`, `README.md`, `DEPLOY.md`, `CHANGELOG.md`: public contract and rollout guidance.

---

### Task 1: Persist device grants and define lifecycle primitives

**Files:**

- Modify: `prisma/schema.prisma:111-187`
- Create: `prisma/migrations/202608260001_device_grants/migration.sql`
- Modify: `packages/security/src/tokens.ts:1-25`
- Create: `packages/security/src/device-grants.ts`
- Modify: `test/auth/device-auth.test.ts:1-17`
- Create: `test/auth/device-grant-schema.test.ts`
- Create: `test/auth/device-grant-lifecycle.test.ts`

**Interfaces:**

- Produces: `createOpaqueToken(random?: (size: number) => Buffer): string`
- Produces: `opaqueTokenHint(token: string): string`
- Produces: `DeviceGrantStatus = 'DELETED' | 'DISABLED' | 'EXPIRED' | 'BOUND' | 'AVAILABLE'`
- Produces: `deriveDeviceGrantStatus(grant, now?): DeviceGrantStatus`
- Produces: `deviceGrantFailure(grant, now?): 'grant_deleted' | 'grant_disabled' | 'grant_expired' | null`

- [ ] **Step 1: Write failing token, lifecycle, and schema tests**

```ts
// test/auth/device-grant-lifecycle.test.ts
import { describe, expect, it } from 'vitest'
import { deriveDeviceGrantStatus, deviceGrantFailure } from '../../packages/security/src/device-grants.js'

const now = new Date('2026-08-26T04:00:00.000Z')
const grant = (overrides: Record<string, unknown> = {}) => ({
  deviceId: null, disabledAt: null, deletedAt: null, expiresAt: null, ...overrides
})

describe('device grant lifecycle', () => {
  it('uses the approved status precedence', () => {
    expect(deriveDeviceGrantStatus(grant(), now)).toBe('AVAILABLE')
    expect(deriveDeviceGrantStatus(grant({ deviceId: 'device-1' }), now)).toBe('BOUND')
    expect(deriveDeviceGrantStatus(grant({ expiresAt: new Date('2026-08-26T03:59:59Z') }), now)).toBe('EXPIRED')
    expect(deriveDeviceGrantStatus(grant({ disabledAt: now, deletedAt: now }), now)).toBe('DELETED')
  })

  it('maps only blocking lifecycle states to stable client errors', () => {
    expect(deviceGrantFailure(grant(), now)).toBeNull()
    expect(deviceGrantFailure(grant({ disabledAt: now }), now)).toBe('grant_disabled')
  })
})
```

```ts
// test/auth/device-grant-schema.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schema = readFileSync('prisma/schema.prisma', 'utf8')
const migration = readFileSync('prisma/migrations/202608260001_device_grants/migration.sql', 'utf8')

describe('device grant schema', () => {
  it('makes member passwords optional and stores one grant per device', () => {
    expect(schema).toContain('passwordHash String?')
    expect(schema).toContain('model DeviceGrant')
    expect(schema).toContain('deviceId')
    expect(schema).toContain('@unique')
  })

  it('retires old authorization tables and revokes legacy devices', () => {
    expect(migration).toContain('DROP TABLE "invitations"')
    expect(migration).toContain('DROP TABLE "device_authorizations"')
    expect(migration).toContain('UPDATE "devices" SET "revoked_at"')
  })
})
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npx vitest run test/auth/device-auth.test.ts test/auth/device-grant-lifecycle.test.ts test/auth/device-grant-schema.test.ts`

Expected: FAIL because `device-grants.ts`, `DeviceGrant`, and the migration do not exist.

- [ ] **Step 3: Add the lifecycle and token primitives**

```ts
// packages/security/src/device-grants.ts
export type DeviceGrantStatus = 'DELETED' | 'DISABLED' | 'EXPIRED' | 'BOUND' | 'AVAILABLE'
export type DeviceGrantFailure = 'grant_deleted' | 'grant_disabled' | 'grant_expired'

export interface DeviceGrantLifecycle {
  deviceId: string | null
  disabledAt: Date | null
  deletedAt: Date | null
  expiresAt: Date | null
}

export function deriveDeviceGrantStatus(grant: DeviceGrantLifecycle, now = new Date()): DeviceGrantStatus {
  if (grant.deletedAt) return 'DELETED'
  if (grant.disabledAt) return 'DISABLED'
  if (grant.expiresAt && grant.expiresAt <= now) return 'EXPIRED'
  return grant.deviceId ? 'BOUND' : 'AVAILABLE'
}

export function deviceGrantFailure(grant: DeviceGrantLifecycle, now = new Date()): DeviceGrantFailure | null {
  const status = deriveDeviceGrantStatus(grant, now)
  if (status === 'DELETED') return 'grant_deleted'
  if (status === 'DISABLED') return 'grant_disabled'
  if (status === 'EXPIRED') return 'grant_expired'
  return null
}
```

```ts
// packages/security/src/tokens.ts
export function createOpaqueToken(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString('base64url')
}

export function opaqueTokenHint(token: string): string {
  return `••••${token.slice(-6)}`
}
```

Remove `createDeviceCode` and its alphabet-specific test. Keep `hashOpaqueToken` and `verifyOpaqueToken` unchanged.

- [ ] **Step 4: Add the Prisma model and explicit SQL migration**

Use nullable device metadata so existing device rows can be retained for usage-log foreign keys:

```prisma
model DeviceGrant {
  id               String       @id @default(uuid()) @db.Uuid
  organizationId   String       @map("organization_id") @db.Uuid
  accountId        String       @map("account_id") @db.Uuid
  tokenHash        String       @unique @map("token_hash")
  tokenHint        String       @map("token_hint")
  expiresAt        DateTime?    @map("expires_at")
  disabledAt       DateTime?    @map("disabled_at")
  deletedAt        DateTime?    @map("deleted_at")
  boundAt          DateTime?    @map("bound_at")
  redeemRetryUntil DateTime?    @map("redeem_retry_until")
  deviceId         String?      @unique @map("device_id") @db.Uuid
  createdById      String       @map("created_by_id") @db.Uuid
  createdAt        DateTime     @default(now()) @map("created_at")
  updatedAt        DateTime     @updatedAt @map("updated_at")
  organization     Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  account          Account      @relation("GrantAccount", fields: [accountId], references: [id], onDelete: Cascade)
  createdBy        Account      @relation("GrantCreator", fields: [createdById], references: [id])
  device           Device?      @relation(fields: [deviceId], references: [id], onDelete: SetNull)

  @@index([organizationId, accountId, createdAt])
  @@index([organizationId, deletedAt, expiresAt])
  @@map("device_grants")
}
```

Also make `Account.passwordHash` nullable, add the two named account relations, add `Organization.deviceGrants`, add `Device.grant`, and add nullable `installationId @unique`, `platform`, and `clientVersion` columns to `Device`.

The migration must: revoke currently unrevoked legacy devices; drop old foreign keys and tables; alter `accounts.password_hash`; add device columns; create `device_grants`, indexes, and foreign keys. Do not delete any `devices` because `usage_logs.device_id` is restrictive.

- [ ] **Step 5: Regenerate Prisma and verify the focused tests**

Run: `npm run db:generate`

Run: `npx vitest run test/auth/device-auth.test.ts test/auth/device-grant-lifecycle.test.ts test/auth/device-grant-schema.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 6: Commit the persistence slice**

```bash
git add prisma/schema.prisma prisma/migrations/202608260001_device_grants packages/security/src/tokens.ts packages/security/src/device-grants.ts test/auth/device-auth.test.ts test/auth/device-grant-lifecycle.test.ts test/auth/device-grant-schema.test.ts package-lock.json
git commit -m "feat: add device grant persistence"
```

---

### Task 2: Add organization-scoped managed users

**Files:**

- Create: `apps/api/src/device-grants.dto.ts`
- Create: `apps/api/src/users.service.ts`
- Create: `apps/api/src/users.controller.ts`
- Modify: `apps/api/src/app.module.ts:5-34`
- Create: `test/auth/users.service.test.ts`
- Create: `test/auth/users.controller.test.ts`

**Interfaces:**

- Produces: `UsersService.create(organizationId, input): Promise<ManagedUser>`
- Produces: `UsersService.list(organizationId, query): Promise<{ items; total; limit; offset }>`
- Produces: `UsersService.detail(organizationId, accountId): Promise<ManagedUserDetail>`
- Produces: `UsersService.disable(organizationId, accountId): Promise<{ status: 'DISABLED' }>`
- Produces: `UsersService.enable(organizationId, accountId): Promise<{ status: 'ACTIVE' }>`

- [ ] **Step 1: Write failing service tests for member creation and lifecycle boundaries**

```ts
describe('managed users', () => {
  it('creates a passwordless MEMBER and membership atomically', async () => {
    const { service, state } = makeUsersHarness()
    const result = await service.create('org-1', { email: ' User@Example.com ', displayName: ' 张三 ' })
    expect(result).toMatchObject({ email: 'user@example.com', displayName: '张三', role: 'MEMBER' })
    expect(state.accounts[0].passwordHash).toBeNull()
    expect(state.memberships[0]).toMatchObject({ organizationId: 'org-1', role: 'MEMBER' })
  })

  it('refuses to disable a platform administrator through member routes', async () => {
    const { service } = makeUsersHarness({ role: 'PLATFORM_ADMIN' })
    await expect(service.disable('org-1', 'account-1')).rejects.toMatchObject({ status: 403 })
  })

  it('does not return users from another organization', async () => {
    const { service } = makeUsersHarness({ secondOrganization: true })
    const result = await service.list('org-1', { limit: 50, offset: 0, q: undefined })
    expect(result.items.every(item => item.organizationId === 'org-1')).toBe(true)
  })
})
```

- [ ] **Step 2: Write failing controller route/delegation tests**

Assert Nest metadata and service arguments for `POST/GET /api/v1/admin/users`, `GET /users/:id`, and explicit `POST /users/:id/disable|enable`, following `test/catalog/model-binding.controller.test.ts`.

- [ ] **Step 3: Run the new user tests and verify they fail**

Run: `npx vitest run test/auth/users.service.test.ts test/auth/users.controller.test.ts`

Expected: FAIL because the DTO, service, and controller do not exist.

- [ ] **Step 4: Implement validated DTOs and the user service**

```ts
export class CreateManagedUserDto {
  @Transform(({ value }) => String(value).trim().toLowerCase())
  @IsEmail() @Length(3, 320) email!: string

  @Transform(({ value }) => String(value).trim())
  @IsString() @Length(1, 120) displayName!: string
}

export class ManagedUserPageQueryDto extends PageQueryDto {
  @IsOptional() @Transform(({ value }) => String(value).trim()) @IsString() @Length(1, 200) q?: string
}
```

`UsersService.create` must use one Prisma transaction, catch Prisma `P2002` as `ConflictException('Account email already exists')`, and return only non-secret fields. List by memberships in the current organization, include counts for grants/devices, and paginate with an exact `total`. Disable/enable must first fetch the current organization's membership and reject `PLATFORM_ADMIN` rather than performing a broad `account.updateMany`.

Architecture clarification: `Account.status` remains the global platform status; managed-user disable/enable changes only the current organization's `Membership.status`. Device authorization checks both states. Login also requires an enabled organization and an `ACTIVE` membership; it deterministically selects `PLATFORM_ADMIN`, then `ORG_ADMIN`, then `MEMBER`, breaking same-role ties by `organizationId`, and signs no JWT if none is valid.

- [ ] **Step 5: Implement routes and register them**

```ts
@ApiTags('admin/users') @ApiBearerAuth() @UseGuards(AuthGuard)
@Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Controller('api/v1/admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Post() create(@Req() req: any, @Body() body: CreateManagedUserDto) { return this.users.create(req.principal.organizationId, body) }
  @Get() list(@Req() req: any, @Query() query: ManagedUserPageQueryDto) { return this.users.list(req.principal.organizationId, query) }
  @Get(':id') detail(@Req() req: any, @Param('id', UuidPipe) id: string) { return this.users.detail(req.principal.organizationId, id) }
  @Post(':id/disable') disable(@Req() req: any, @Param('id', UuidPipe) id: string) { return this.users.disable(req.principal.organizationId, id) }
  @Post(':id/enable') enable(@Req() req: any, @Param('id', UuidPipe) id: string) { return this.users.enable(req.principal.organizationId, id) }
}
```

Add `UsersController` and `UsersService` to `AppModule`.

- [ ] **Step 6: Run user tests and type checking**

Run: `npx vitest run test/auth/users.service.test.ts test/auth/users.controller.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit managed users**

```bash
git add apps/api/src/device-grants.dto.ts apps/api/src/users.service.ts apps/api/src/users.controller.ts apps/api/src/app.module.ts test/auth/users.service.test.ts test/auth/users.controller.test.ts
git commit -m "feat: manage passwordless server users"
```

---

### Task 3: Add grant creation, listing, and lifecycle management

**Files:**

- Create: `apps/api/src/device-grants.service.ts`
- Create: `apps/api/src/device-grants.controller.ts`
- Modify: `apps/api/src/device-grants.dto.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/governance.controller.ts:1-33`
- Create: `test/auth/device-grants.service.test.ts`
- Create: `test/auth/device-grants.controller.test.ts`

**Interfaces:**

- Produces: `DeviceGrantsService.create(organizationId, actorId, accountId, input)`
- Produces: `DeviceGrantsService.listGrouped(organizationId, query)`
- Produces: `DeviceGrantsService.updateExpiration(organizationId, grantId, expiresAt)`
- Produces: `DeviceGrantsService.disable|enable|delete(organizationId, grantId)`
- Consumes: lifecycle primitives from Task 1 and DTO pagination from Task 2.

- [ ] **Step 1: Write failing lifecycle service tests**

Cover these exact assertions:

```ts
it('returns a connection URL once while storing only hash and hint', async () => {
  const { service, state } = makeGrantHarness()
  process.env.PUBLIC_URL = 'http://10.0.0.8:3000'
  const result = await service.create('org-1', 'admin-1', 'account-1', { expiresAt: null })
  const token = new URL(result.connectionUrl).hash.slice('#token='.length)
  expect(result.connectionUrl).toBe(`http://10.0.0.8:3000/connect#token=${token}`)
  expect(result).not.toHaveProperty('token')
  expect(state.grants[0].tokenHash).not.toContain(token)
  expect(state.grants[0].tokenHint).toMatch(/^••••/)
})

it('disables reversibly without revoking the device', async () => {
  const { service, state } = makeGrantHarness({ bound: true })
  await service.disable('org-1', 'grant-1')
  expect(state.grants[0].disabledAt).toBeInstanceOf(Date)
  expect(state.devices[0].revokedAt).toBeNull()
  await service.enable('org-1', 'grant-1')
  expect(state.grants[0].disabledAt).toBeNull()
})

it('soft deletes and permanently revokes the bound device', async () => {
  const { service, state } = makeGrantHarness({ bound: true })
  await service.delete('org-1', 'grant-1')
  expect(state.grants[0].deletedAt).toBeInstanceOf(Date)
  expect(state.devices[0].revokedAt).toBeInstanceOf(Date)
})
```

Also test: target user must belong to the organization; non-future `expiresAt` is rejected; deleted grants cannot be enabled or extended; grouped pagination counts users rather than grants; raw hashes are absent from all outputs.

- [ ] **Step 2: Write failing admin controller tests**

Assert exact route metadata and delegation for create, grouped list, patch expiry, disable, enable, and delete. Verify every service call receives `request.principal.organizationId`.

- [ ] **Step 3: Run focused tests and verify they fail**

Run: `npx vitest run test/auth/device-grants.service.test.ts test/auth/device-grants.controller.test.ts`

Expected: FAIL because the grant service/controller do not exist.

- [ ] **Step 4: Add grant DTOs and serialization**

```ts
export class CreateDeviceGrantDto {
  @IsOptional() @ValidateIf((_, value) => value !== null)
  @IsDateString({ strict: true }) expiresAt?: string | null
}

export class UpdateDeviceGrantDto {
  @ValidateIf((_, value) => value !== null)
  @IsDateString({ strict: true }) expiresAt!: string | null
}

export enum DeviceGrantFilter {
  ALL = 'ALL', AVAILABLE = 'AVAILABLE', BOUND = 'BOUND', DISABLED = 'DISABLED', EXPIRED = 'EXPIRED', DELETED = 'DELETED'
}

export class DeviceGrantPageQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(DeviceGrantFilter) status: DeviceGrantFilter = DeviceGrantFilter.ALL
  @IsOptional() @IsString() @Length(1, 200) q?: string
}
```

Because `@IsDateString` skips `null` only when optional handling is explicit, use `@ValidateIf((_, value) => value !== null)` on nullable expiry fields. Convert strings to `Date` only inside the service.

- [ ] **Step 5: Implement lifecycle methods and grouped queries**

Create grants only for an active `MEMBER` membership in the same organization. Generate with `createOpaqueToken()`, store `hashOpaqueToken(token)` and `opaqueTokenHint(token)`, and construct:

```ts
const origin = new URL(process.env.PUBLIC_URL || 'http://localhost:3000').origin
const connectionUrl = `${origin}/connect#token=${encodeURIComponent(token)}`
```

Return only the safe grant summary and `connectionUrl` from `create`; the original token exists only in its fragment, never as a bare response field. Every other serializer must explicitly select fields and add `status: deriveDeviceGrantStatus(grant, now)`.

Implement delete in one transaction that updates `DeviceGrant.deletedAt` and, when `deviceId` exists, updates `Device.revokedAt`. Implement grouped listing by first paginating account IDs and then loading their grants/devices; do not paginate flat grants and regroup an incomplete page.

Translate status filters to exact, mutually exclusive Prisma predicates using one captured `now`:

```ts
const activeExpiry = [{ expiresAt: null }, { expiresAt: { gt: now } }]
const statusWhere = {
  AVAILABLE: { deletedAt: null, disabledAt: null, OR: activeExpiry, deviceId: null },
  BOUND: { deletedAt: null, disabledAt: null, OR: activeExpiry, deviceId: { not: null } },
  DISABLED: { deletedAt: null, disabledAt: { not: null } },
  EXPIRED: { deletedAt: null, disabledAt: null, expiresAt: { lte: now } },
  DELETED: { deletedAt: { not: null } }
} satisfies Record<Exclude<DeviceGrantFilter, 'ALL'>, Prisma.DeviceGrantWhereInput>
```

For `ALL`, exclude deleted grants by default with `{ deletedAt: null }`; `DELETED` is the explicit history view.

- [ ] **Step 6: Implement routes and retire overlapping governance methods**

```ts
@ApiTags('admin/device-grants') @ApiBearerAuth() @UseGuards(AuthGuard)
@Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Controller('api/v1/admin')
export class DeviceGrantsController {
  constructor(private readonly grants: DeviceGrantsService) {}
  @Post('users/:userId/device-grants')
  create(@Req() req: any, @Param('userId', UuidPipe) userId: string, @Body() body: CreateDeviceGrantDto) {
    return this.grants.create(req.principal.organizationId, req.principal.sub, userId, body)
  }
  @Get('device-grants')
  list(@Req() req: any, @Query() query: DeviceGrantPageQueryDto) {
    return this.grants.listGrouped(req.principal.organizationId, query)
  }
  @Patch('device-grants/:id')
  update(@Req() req: any, @Param('id', UuidPipe) id: string, @Body() body: UpdateDeviceGrantDto) {
    return this.grants.updateExpiration(req.principal.organizationId, id, body.expiresAt)
  }
  @Post('device-grants/:id/disable')
  disable(@Req() req: any, @Param('id', UuidPipe) id: string) {
    return this.grants.disable(req.principal.organizationId, id)
  }
  @Post('device-grants/:id/enable')
  enable(@Req() req: any, @Param('id', UuidPipe) id: string) {
    return this.grants.enable(req.principal.organizationId, id)
  }
  @Delete('device-grants/:id')
  delete(@Req() req: any, @Param('id', UuidPipe) id: string) {
    return this.grants.delete(req.principal.organizationId, id)
  }
}
```

Remove invitation creation, member listing, device listing, and direct device revoke from `GovernanceController`; quotas and audit remain there.

- [ ] **Step 7: Verify and commit the admin grant slice**

Run: `npx vitest run test/auth/device-grants.service.test.ts test/auth/device-grants.controller.test.ts test/auth/users.service.test.ts`

Run: `npm run typecheck`

```bash
git add apps/api/src/device-grants.dto.ts apps/api/src/device-grants.service.ts apps/api/src/device-grants.controller.ts apps/api/src/governance.controller.ts apps/api/src/app.module.ts test/auth/device-grants.service.test.ts test/auth/device-grants.controller.test.ts
git commit -m "feat: manage device authorization grants"
```

---

### Task 4: Preview and transactionally redeem a grant

**Files:**

- Modify: `apps/api/src/device-grants.dto.ts`
- Modify: `apps/api/src/device-grants.service.ts`
- Modify: `apps/api/src/auth.controller.ts:1-24`
- Modify: `apps/api/src/app.module.ts`
- Create: `test/auth/device-grant-redeem.test.ts`
- Modify: `test/auth/device-grants.controller.test.ts`

**Interfaces:**

- Produces: `DeviceGrantsService.preview(token): Promise<GrantPreview>`
- Produces: `DeviceGrantsService.redeem(input): Promise<DeviceCredentialResponse>`
- Produces public routes `POST /api/v1/auth/device-grants/preview|redeem` with `Cache-Control: no-store`.

- [ ] **Step 1: Write failing preview and redeem tests**

```ts
it('previews without consuming the grant', async () => {
  const { service, state } = makeRedeemHarness()
  const preview = await service.preview('grant-secret')
  expect(preview).toMatchObject({ account: { displayName: '张三' }, authorization: { expiresAt: null } })
  expect(state.grants[0].boundAt).toBeNull()
})

it('binds one installation and returns device credentials', async () => {
  const { service, state } = makeRedeemHarness()
  const result = await service.redeem(redeemInput('installation-1'))
  expect(result).toMatchObject({ expiresIn: 900, authorization: { expiresAt: null } })
  expect(result.refreshToken).toEqual(expect.any(String))
  expect(state.grants[0]).toMatchObject({ deviceId: expect.any(String), boundAt: expect.any(Date), redeemRetryUntil: expect.any(Date) })
})

it('allows only the same installation to retry for ten minutes', async () => {
  const { service } = makeRedeemHarness({ boundInstallationId: 'installation-1', retryUntil: '2026-08-26T04:10:00Z' })
  await expect(service.redeem(redeemInput('installation-1'))).resolves.toHaveProperty('refreshToken')
  await expect(service.redeem(redeemInput('installation-2'))).rejects.toMatchObject({ response: { code: 'grant_already_bound' } })
})
```

Also test disabled, expired, deleted, inactive account, inactive organization, invalid device metadata, and a simulated two-transaction race where the second observes the first binding. Preview returns metadata plus the derived status for a known disabled, expired, or deleted grant so the browser can explain the problem; redeem rejects those same states with the stable error code.

- [ ] **Step 2: Run redeem tests and verify they fail**

Run: `npx vitest run test/auth/device-grant-redeem.test.ts test/auth/device-grants.controller.test.ts`

Expected: FAIL because preview/redeem DTOs and methods are missing.

- [ ] **Step 3: Add nested validated device DTOs**

```ts
export class DeviceRegistrationDto {
  @IsUUID('4') installationId!: string
  @Transform(({ value }) => String(value).trim()) @IsString() @Length(1, 120) name!: string
  @IsIn(['windows', 'macos', 'linux']) platform!: string
  @IsString() @Length(1, 32) clientVersion!: string
}

export class PreviewDeviceGrantDto {
  @IsString() @Length(32, 128) token!: string
}

export class RedeemDeviceGrantDto extends PreviewDeviceGrantDto {
  @ValidateNested() @Type(() => DeviceRegistrationDto) device!: DeviceRegistrationDto
}
```

- [ ] **Step 4: Implement preview and row-locked redeem**

Inside `prisma.$transaction`, lock the matching row before reading mutable state:

```ts
const tokenHash = hashOpaqueToken(input.token)
const locked = await transaction.$queryRaw<Array<{ id: string }>>`
  SELECT "id" FROM "device_grants" WHERE "token_hash" = ${tokenHash} FOR UPDATE
`
if (!locked[0]) throw grantException('invalid_grant')
const grant = await transaction.deviceGrant.findUnique({
  where: { id: locked[0].id },
  include: { account: true, organization: true, device: true }
})
```

Validate lifecycle with `deviceGrantFailure`. On first redemption, create a device with a new opaque refresh token hash, set the grant relation and the 10-minute retry deadline, and sign the existing 15-minute JWT principal. On valid retry, rotate the existing device refresh token. Never return `tokenHash` or `refreshTokenHash`.

- [ ] **Step 5: Expose public routes with no-store responses**

```ts
@Header('Cache-Control', 'no-store')
@Post('device-grants/preview')
preview(@Body() body: PreviewDeviceGrantDto) { return this.grants.preview(body.token) }

@Header('Cache-Control', 'no-store')
@Post('device-grants/redeem')
redeem(@Body() body: RedeemDeviceGrantDto) { return this.grants.redeem(body) }
```

Inject `DeviceGrantsService` into `AuthController`. Do not guard these two routes. Keep validation global through the DTOs.

- [ ] **Step 6: Verify route metadata, race behavior, and no secret leakage**

Run: `npx vitest run test/auth/device-grant-redeem.test.ts test/auth/device-grants.controller.test.ts test/http/audit-interceptor.test.ts`

Expected: PASS, including assertions that exceptions and serialized results omit the raw token.

- [ ] **Step 7: Commit public registration**

```bash
git add apps/api/src/device-grants.dto.ts apps/api/src/device-grants.service.ts apps/api/src/auth.controller.ts apps/api/src/app.module.ts test/auth/device-grant-redeem.test.ts test/auth/device-grants.controller.test.ts
git commit -m "feat: redeem device grants"
```

---

### Task 5: Enforce grant state during refresh, bootstrap, and every device request

**Files:**

- Modify: `apps/api/src/auth.service.ts:1-134`
- Modify: `apps/api/src/auth.controller.ts:10-24`
- Modify: `packages/security/src/auth.ts:23-55`
- Modify: `apps/api/src/client.controller.ts:7-23`
- Create: `test/auth/device-grant-auth.test.ts`
- Create: `test/auth/device-grant-client-metadata.test.ts`
- Modify: `test/auth/device-auth.test.ts`

**Interfaces:**

- Consumes: `deviceGrantFailure` from Task 1 and grant/device relation from Task 4.
- Produces: refresh and bootstrap `authorization: { expiresAt: string | null; serverTime: string }`.
- Removes: invitation acceptance, device code creation/poll/approval, and their service methods.

- [ ] **Step 1: Write failing null-password and refresh tests**

```ts
it('rejects password login for a passwordless member without calling argon2.verify', async () => {
  const { service, verify } = makeAuthHarness({ passwordHash: null })
  await expect(service.login({ email: 'member@example.com', password: 'ignored' })).rejects.toMatchObject({ status: 401 })
  expect(verify).not.toHaveBeenCalled()
})

it.each([
  ['disabled', { disabledAt: new Date() }, 'grant_disabled'],
  ['expired', { expiresAt: new Date('2026-08-25T00:00:00Z') }, 'grant_expired'],
  ['deleted', { deletedAt: new Date() }, 'grant_deleted']
])('rejects refresh for a %s grant', async (_name, grant, code) => {
  const { service } = makeAuthHarness({ grant })
  await expect(service.refresh('refresh-secret')).rejects.toMatchObject({ response: { code } })
})
```

- [ ] **Step 2: Write failing guard and bootstrap tests**

Assert that a device JWT with no grant is rejected, a disabled grant is rejected with `grant_disabled`, a valid grant succeeds, and bootstrap returns the exact latest `expiresAt` plus a service-generated `serverTime`.

- [ ] **Step 3: Run focused auth tests and verify they fail**

Run: `npx vitest run test/auth/device-auth.test.ts test/auth/device-grant-auth.test.ts test/auth/device-grant-client-metadata.test.ts`

Expected: FAIL against the legacy refresh/guard/bootstrap behavior.

- [ ] **Step 4: Make password operations nullable-safe and remove legacy service methods**

Use short-circuit checks before Argon2:

```ts
if (!account || account.status !== 'ACTIVE' || !account.passwordHash ||
  !await argon2.verify(account.passwordHash, input.password)) {
  throw new UnauthorizedException('Invalid credentials')
}
```

Apply the same `passwordHash` guard to password change. Delete `acceptInvitation`, `startDevice`, `approveDevice`, and `pollDevice` from `AuthService`, and remove their routes from `AuthController`.

- [ ] **Step 5: Enforce live grant state in refresh and AuthGuard**

Refresh must load `device.grant`, call `deviceGrantFailure`, rotate only after all checks pass, and return:

```ts
authorization: {
  expiresAt: device.grant.expiresAt?.toISOString() ?? null,
  serverTime: now.toISOString()
}
```

For JWT device principals, `AuthGuard` must fetch the device with its grant, validate ownership, live grant state, and permanent revocation in that order. This order ensures a soft-deleted grant returns `grant_deleted` even though deletion also sets `Device.revokedAt`. Throw `UnauthorizedException({ code, message: clientMessage(code) })` so the JSON body has a stable `code`. Administrator JWTs without `deviceId` continue using account/membership checks only.

- [ ] **Step 6: Return current grant metadata from bootstrap**

When `request.principal.deviceId` is present, load that device's grant in the existing bootstrap query and add the same `authorization` object. Reject missing or inactive grant rather than returning stale model/skill configuration.

- [ ] **Step 7: Verify and commit live authorization**

Run: `npx vitest run test/auth/device-auth.test.ts test/auth/device-grant-auth.test.ts test/auth/device-grant-client-metadata.test.ts test/gateway/access-policy.test.ts`

Run: `npm run typecheck`

```bash
git add apps/api/src/auth.service.ts apps/api/src/auth.controller.ts apps/api/src/client.controller.ts packages/security/src/auth.ts test/auth/device-auth.test.ts test/auth/device-grant-auth.test.ts test/auth/device-grant-client-metadata.test.ts
git commit -m "feat: enforce live device grants"
```

---

### Task 6: Add the public browser connection page and remove old public pages

**Files:**

- Create: `apps/admin/src/device-grant-connect.ts`
- Create: `apps/admin/src/views/Connect.vue`
- Modify: `apps/admin/src/api.ts:1-25`
- Modify: `apps/admin/src/main.ts:1-42`
- Modify: `apps/admin/src/App.vue:1-78`
- Delete: `apps/admin/src/views/InviteAccept.vue`
- Delete: `apps/admin/src/views/DeviceApproval.vue`
- Create: `test/admin/device-grant-connect.test.ts`

**Interfaces:**

- Produces: `readGrantToken(hash: string): string`
- Produces: `buildUcliConnectUrl(serverBaseUrl: string, token: string): string`
- Produces: `publicApi<T>(path, init): Promise<T>` without Bearer injection or login reload.

- [ ] **Step 1: Write failing pure browser-flow tests**

```ts
describe('device grant browser connection', () => {
  it('reads the opaque token only from the fragment', () => {
    expect(readGrantToken('#token=grant%20secret')).toBe('grant secret')
    expect(readGrantToken('')).toBe('')
  })

  it('builds the exact UCLI protocol URL with a normalized origin', () => {
    expect(buildUcliConnectUrl('http://10.0.0.8:3000/path', 'grant secret')).toBe(
      'ucli://connect?server=http%3A%2F%2F10.0.0.8%3A3000#token=grant%20secret'
    )
  })

  it('rejects non-http server protocols', () => {
    expect(() => buildUcliConnectUrl('file:///tmp/server', 'secret')).toThrow('Unsupported server protocol')
  })
})
```

- [ ] **Step 2: Run the browser tests and verify they fail**

Run: `npx vitest run test/admin/device-grant-connect.test.ts`

Expected: FAIL because the helper file does not exist.

- [ ] **Step 3: Implement safe URL helpers and unauthenticated API calls**

```ts
export function readGrantToken(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token')?.trim() || ''
}

export function buildUcliConnectUrl(serverBaseUrl: string, token: string): string {
  const server = new URL(serverBaseUrl)
  if (!['http:', 'https:'].includes(server.protocol)) throw new Error('Unsupported server protocol')
  const target = new URL('ucli://connect')
  target.searchParams.set('server', server.origin)
  target.hash = `token=${encodeURIComponent(token)}`
  return target.toString()
}
```

Add `publicApi` beside `api`; it sends JSON content type but never an authorization header and never clears administrator local storage on 401:

```ts
export async function publicApi<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers }
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.message || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}
```

- [ ] **Step 4: Build the public `Connect.vue` flow**

On mount: read `window.location.hash`, clear it with `history.replaceState` after copying the token into component memory, call preview with `publicApi`, and render server origin, organization, account, status, and expiry. The “连接 UCLI” button assigns `window.location.href = buildUcliConnectUrl(window.location.origin, token)`. Include an explicit copy-link fallback and an “未安装 UCLI” explanation.

Do not render the raw token or include it in DOM text, error text, or console output.

- [ ] **Step 5: Register the public route and remove old routes/pages**

Add `{ path: '/connect', name: 'connect', component: Connect, meta: { public: true } }`. Remove `device` and `invite` routes/imports. Change `App.vue` public-shell condition to `route.meta.public === true`, preserving the administrator login shell for every other unauthenticated route.

- [ ] **Step 6: Build and commit the browser slice**

Run: `npx vitest run test/admin/device-grant-connect.test.ts`

Run: `npm run admin:build`

```bash
git add apps/admin/src/device-grant-connect.ts apps/admin/src/views/Connect.vue apps/admin/src/api.ts apps/admin/src/main.ts apps/admin/src/App.vue apps/admin/src/views/InviteAccept.vue apps/admin/src/views/DeviceApproval.vue test/admin/device-grant-connect.test.ts
git commit -m "feat: launch UCLI from grant links"
```

---

### Task 7: Add user and grant administration views

**Files:**

- Create: `apps/admin/src/device-grants.ts`
- Create: `apps/admin/src/device-grants.css`
- Create: `apps/admin/src/views/Users.vue`
- Create: `apps/admin/src/views/UserDetail.vue`
- Create: `apps/admin/src/views/DeviceGrants.vue`
- Modify: `apps/admin/src/main.ts`
- Modify: `apps/admin/src/App.vue:13-18`
- Modify: `apps/admin/src/views/Governance.vue:1-165`
- Create: `test/admin/device-grant-management.test.ts`
- Create: `test/admin/device-grant-views.test.ts`

**Interfaces:**

- Consumes: admin user/grant APIs from Tasks 2 and 3.
- Produces: `grantStatusLabel`, `grantActions`, `grantExpiryPayload`, and `deviceGrantQuery` pure UI helpers.

- [ ] **Step 1: Write failing admin helper tests**

```ts
it('offers reversible actions for disabled grants and no actions for deleted grants', () => {
  expect(grantActions({ status: 'DISABLED' })).toEqual(['enable', 'edit-expiry', 'delete'])
  expect(grantActions({ status: 'DELETED' })).toEqual([])
})

it('maps the permanent option to a null expiry', () => {
  expect(grantExpiryPayload({ permanent: true, expiresAt: '2026-12-31T00:00' })).toEqual({ expiresAt: null })
})

it('builds encoded grouped-list filters', () => {
  expect(deviceGrantQuery({ status: 'EXPIRED', q: '张 三', limit: 50, offset: 0 }))
    .toBe('status=EXPIRED&q=%E5%BC%A0+%E4%B8%89&limit=50&offset=0')
})
```

- [ ] **Step 2: Write failing source-level view contract tests**

Following the repository's existing admin tests, assert that:

- `Users.vue` posts to `/api/v1/admin/users` and links to `/users/:id`.
- `UserDetail.vue` calls the nested grant creation route and renders grants plus devices.
- `DeviceGrants.vue` calls grouped `/api/v1/admin/device-grants` and contains enable, disable, expiry, and delete actions.
- Creation dialogs contain the exact warning `关闭后无法再次查看完整令牌` and a copy action.
- Delete confirmation contains the exact warning `关联设备将被永久撤销`.

```ts
const usersView = readFileSync('apps/admin/src/views/Users.vue', 'utf8')
const detailView = readFileSync('apps/admin/src/views/UserDetail.vue', 'utf8')
const grantsView = readFileSync('apps/admin/src/views/DeviceGrants.vue', 'utf8')

expect(usersView).toContain("api('/api/v1/admin/users'")
expect(detailView).toContain('users/${userId}/device-grants')
expect(detailView).toContain('关闭后无法再次查看完整令牌')
expect(grantsView).toContain('关联设备将被永久撤销')
expect(grantsView).toContain("/disable")
expect(grantsView).toContain("/enable")
```

- [ ] **Step 3: Run admin tests and verify they fail**

Run: `npx vitest run test/admin/device-grant-management.test.ts test/admin/device-grant-views.test.ts`

Expected: FAIL because helpers and views do not exist.

- [ ] **Step 4: Implement pure UI policy helpers**

Define typed `ManagedUser`, `ManagedUserDetail`, `DeviceGrantSummary`, and `ManagedDevice` response shapes in `device-grants.ts`. Centralize labels and permitted actions so `Users.vue`, `UserDetail.vue`, and `DeviceGrants.vue` do not duplicate lifecycle rules:

```ts
export type GrantAction = 'disable' | 'enable' | 'edit-expiry' | 'delete'

export function grantActions(grant: Pick<DeviceGrantSummary, 'status'>): GrantAction[] {
  if (grant.status === 'DELETED') return []
  if (grant.status === 'DISABLED') return ['enable', 'edit-expiry', 'delete']
  return ['disable', 'edit-expiry', 'delete']
}

export function grantExpiryPayload(form: { permanent: boolean; expiresAt: string }) {
  if (form.permanent) return { expiresAt: null }
  if (!form.expiresAt) throw new Error('请选择有效期')
  return { expiresAt: new Date(form.expiresAt).toISOString() }
}

export function deviceGrantQuery(input: { status: string; q: string; limit: number; offset: number }) {
  const query = new URLSearchParams({ status: input.status })
  if (input.q.trim()) query.set('q', input.q.trim())
  query.set('limit', String(input.limit))
  query.set('offset', String(input.offset))
  return query.toString()
}
```

Expiry conversion must use `new Date(localValue).toISOString()` for a dated authorization and `null` for permanent. Empty dated values are rejected client-side before the request.

- [ ] **Step 5: Implement user list and detail views**

`Users.vue` provides email/display-name creation, search, pagination, counts, status badges, and enable/disable actions. `UserDetail.vue` loads one user, shows devices and grants, and opens a create-grant dialog with permanent selected by default. Use these exact request boundaries:

```ts
await api('/api/v1/admin/users', { method: 'POST', body: JSON.stringify(createForm.value) })
const user = await api<ManagedUserDetail>(`/api/v1/admin/users/${userId}`)
const created = await api<{ connectionUrl: string }>(
  `/api/v1/admin/users/${userId}/device-grants`,
  { method: 'POST', body: JSON.stringify(grantExpiryPayload(grantForm.value)) }
)
```

After grant creation, show `connectionUrl` in a modal with `navigator.clipboard.writeText(connectionUrl)`. The API returns no bare `token`; clear the one-time connection URL from component state when the modal closes.

- [ ] **Step 6: Implement grouped grant administration**

`DeviceGrants.vue` paginates users, not flat grants. It supports status/search filters, expiry editing, permanent conversion, disable, enable, and delete. Deleted grants render only when the filter includes them and never render restore/edit actions. Lifecycle calls are explicit:

```ts
await api(`/api/v1/admin/device-grants/${grant.id}/${action}`, { method: 'POST' })
await api(`/api/v1/admin/device-grants/${grant.id}`, {
  method: 'PATCH', body: JSON.stringify(grantExpiryPayload(expiryForm.value))
})
await api(`/api/v1/admin/device-grants/${grant.id}`, { method: 'DELETE' })
```

Use the shared `ConfirmDialog` for delete and disable. Use existing `StatusBadge`, `Pagination`, toast, and error presentation patterns.

- [ ] **Step 7: Update routes, navigation, governance, and styles**

Add `/users`, `/users/:id`, and `/device-grants`. Add `用户管理` and `授权令牌` navigation entries. Remove member invitation and device tabs/state from `Governance.vue`; keep quotas and audit under `治理`. Import `device-grants.css` from `main.ts`.

- [ ] **Step 8: Test, build, and commit the admin UI**

Run: `npx vitest run test/admin/device-grant-management.test.ts test/admin/device-grant-views.test.ts test/admin/model-form-errors.test.ts`

Run: `npm run admin:build`

```bash
git add apps/admin/src/device-grants.ts apps/admin/src/device-grants.css apps/admin/src/views/Users.vue apps/admin/src/views/UserDetail.vue apps/admin/src/views/DeviceGrants.vue apps/admin/src/main.ts apps/admin/src/App.vue apps/admin/src/views/Governance.vue test/admin/device-grant-management.test.ts test/admin/device-grant-views.test.ts
git commit -m "feat: manage users and device grants"
```

---

### Task 8: Publish the protocol, migration warning, and full verification

**Files:**

- Modify: `docs/ucli-client-protocol.md:1-16`
- Modify: `README.md:37-84`
- Modify: `DEPLOY.md:27-47`
- Modify: `CHANGELOG.md`
- Create: `test/auth/device-grant-protocol.test.ts`

**Interfaces:**

- Documents the exact `connectionUrl`, `ucli://` URL, preview/redeem payloads, refresh/bootstrap authorization metadata, stable error codes, and standalone-client degradation behavior.

- [ ] **Step 1: Write a failing protocol contract test**

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const protocol = readFileSync('docs/ucli-client-protocol.md', 'utf8')
const deploy = readFileSync('DEPLOY.md', 'utf8')

describe('device grant client protocol documentation', () => {
  it('documents the complete replacement registration flow', () => {
    for (const text of [
      '/connect#token=', 'ucli://connect', '/device-grants/preview', '/device-grants/redeem',
      'installationId', 'authorization', 'grant_disabled', 'grant_expired', 'grant_deleted'
    ]) expect(protocol).toContain(text)
  })

  it('documents the trusted-network HTTP and PUBLIC_URL requirements', () => {
    expect(deploy).toContain('PUBLIC_URL')
    expect(deploy).toContain('可信公司内网')
  })
})
```

- [ ] **Step 2: Run the protocol test and verify it fails**

Run: `npx vitest run test/auth/device-grant-protocol.test.ts`

Expected: FAIL because the current protocol still describes device-code approval.

- [ ] **Step 3: Replace the client registration protocol section**

Document UCLI standalone mode first, then the exact browser link, protocol URL, preview, redeem, 10-minute same-installation retry, secure storage, refresh rotation, authorization metadata, expiry reminders, one-server limit, error mapping, and the rule that local capabilities survive every server failure.

Remove all device-code polling and browser approval instructions.

- [ ] **Step 4: Update operator and release documentation**

- README: replace “subsequent users join by invitation” with platform-created members and per-device grants.
- DEPLOY: state that `PUBLIC_URL` must be the exact UCLI-reachable `http://IP[:port]` origin and that approved HTTP operation assumes a trusted company network.
- CHANGELOG: add passwordless managed members, one-device grants, grant lifecycle, browser launch, and the breaking removal of old invitation/device-code flows.

- [ ] **Step 5: Run all targeted authentication and admin tests**

Run:

```bash
npx vitest run test/auth test/admin/device-grant-connect.test.ts test/admin/device-grant-management.test.ts test/admin/device-grant-views.test.ts test/http/audit-interceptor.test.ts test/gateway/access-policy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run repository-wide verification**

Run: `npm run db:generate`

Run: `npm run verify`

Expected: typecheck, coverage thresholds, all tests, server build, admin build, and license check PASS.

- [ ] **Step 7: Inspect the destructive migration and secret exposure boundary**

Run:

```bash
rg -n -S "(Invitation|DeviceAuthorization|device/code|device/approve|invitations/accept)" apps packages docs README.md
rg -n -S "(tokenHash|refreshTokenHash|grant-secret)" apps/admin apps/api/src | sort
git diff --check
```

Expected: the first command finds no runtime or protocol references to the removed flow; the second finds secret fields only in controlled persistence/authentication code and never in serializers, logs, or Vue templates; `git diff --check` prints nothing.

- [ ] **Step 8: Commit documentation and final acceptance**

```bash
git add docs/ucli-client-protocol.md README.md DEPLOY.md CHANGELOG.md test/auth/device-grant-protocol.test.ts
git commit -m "docs: publish device grant registration protocol"
```

After this commit, hand `docs/ucli-client-registration-upgrade.md` and `docs/ucli-client-protocol.md` to the UCLI client repository. The client implementation is not part of this server branch.

---

## Rollback

The database migration intentionally drops invitation and device-authorization tables and revokes legacy devices. Before deployment, take the repository-standard database backup. Application rollback requires restoring that database backup together with the previous application images; rolling back only the application binaries is unsupported because the old schema tables no longer exist.

Use:

```powershell
./scripts/backup.ps1
```

For the packaged Linux deployment, use the documented platform backup process before `./install.sh update`. If verification fails before deployment, revert only this feature's commits; do not use destructive working-tree reset commands.
