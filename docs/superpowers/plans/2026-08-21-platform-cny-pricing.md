# Platform CNY Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RMB the platform-wide business currency for procurement prices, scheduled channel costs, quotas, usage analytics, reports, and admin UI.

**Architecture:** Keep existing persisted amount-column mappings and API compatibility fields for this development release, but make every newly resolved price snapshot explicitly `CNY` and render it as `¥`. Update active catalog data to official DeepSeek CNY prices; archived records remain immutable audit history.

**Tech Stack:** TypeScript, NestJS, Prisma, Vue 3, Vitest, Decimal.js.

## Global Constraints

- The platform business currency is `CNY`; user-facing money uses `¥` and Chinese yuan labels.
- Do not calculate employee sales prices; all money represents company procurement cost or internal quota.
- Historical archived price versions and usage records remain recoverable.
- Existing database amount column names are retained in this release to avoid destructive data migration; public compatibility keys may remain while displayed semantics are CNY.

---

### Task 1: CNY Cost Contract

**Files:**
- Modify: `packages/gateway-core/src/cost-schedule.ts`
- Modify: `apps/api/src/channel-models.service.ts`
- Modify: `apps/api/src/catalog.dto.ts`
- Test: `test/gateway/cost-schedule.test.ts`
- Test: `test/catalog/channel-models.service.test.ts`
- Test: `test/catalog/catalog.dto.test.ts`

**Interfaces:**
- Consumes: existing `ScheduledCost`, `ResolvedCost`, and cost-rule CRUD inputs.
- Produces: scheduled costs whose only accepted/resolved currency is `CNY`.

- [ ] **Step 1: Write failing tests** asserting that `CNY` scheduled costs resolve, `USD` rules are rejected, newly created rules persist `currency: 'CNY'`, and model price DTO defaults to `CNY`.
- [ ] **Step 2: Run** `npm test -- test/gateway/cost-schedule.test.ts test/catalog/channel-models.service.test.ts test/catalog/catalog.dto.test.ts` and verify failures are currency-contract mismatches.
- [ ] **Step 3: Implement** `ResolvedCost.currency: 'CNY'`, CNY validation/messages, CNY cost-rule persistence, and CNY DTO defaults.
- [ ] **Step 4: Re-run the three tests** and verify they pass.

### Task 2: Runtime CNY Snapshots

**Files:**
- Modify: `apps/api/src/model-testing.service.ts`
- Modify: `apps/api/src/models.service.ts`
- Modify: `apps/gateway/src/gateway.service.ts`
- Modify: `apps/worker/src/worker.service.ts`
- Modify: `packages/reports/src/operations-report.ts`
- Modify: `packages/monitoring/src/quota-metrics.ts`
- Test: `test/catalog/model-testing.service.test.ts`
- Test: `test/catalog/models.service.test.ts`
- Test: `test/gateway/gateway.service.test.ts`
- Test: `test/reports/operations-report.test.ts`
- Test: `test/monitoring/quota-metrics.test.ts`

**Interfaces:**
- Consumes: CNY catalog prices and scheduled costs.
- Produces: usage cost snapshots, model-test estimates, reports, and metrics consistently described as RMB procurement cost.

- [ ] **Step 1: Write failing tests** asserting CNY health-check placeholders, CNY fallback snapshots, `¥` reports, and RMB metric help text.
- [ ] **Step 2: Run the five targeted test files** and verify the expected USD/default-symbol failures.
- [ ] **Step 3: Replace runtime USD literals with CNY** while preserving existing compatibility property names used by the current database/API.
- [ ] **Step 4: Re-run targeted tests** and verify they pass.

### Task 3: Admin RMB Presentation

**Files:**
- Modify: `apps/admin/src/types/catalog.ts`
- Modify: `apps/admin/src/components/CostScheduleEditor.vue`
- Modify: `apps/admin/src/views/ModelDetail.vue`
- Modify: `apps/admin/src/views/Models.vue`
- Modify: `apps/admin/src/views/Analytics.vue`
- Modify: `apps/admin/src/views/Usage.vue`
- Modify: `apps/admin/src/views/ModelTest.vue`
- Modify: `apps/admin/src/views/Governance.vue`
- Modify: `apps/admin/src/Dashboard.vue`
- Modify: `apps/admin/src/views/Reports.vue`
- Test: `test/admin/cny-currency.test.ts`
- Test: `test/admin/model-groups.test.ts`

**Interfaces:**
- Consumes: existing API amount fields carrying CNY business values.
- Produces: forms fixed to CNY and all user-visible procurement-cost displays formatted with `¥`.

- [ ] **Step 1: Add failing admin contract tests** for CNY form defaults/types and RMB symbols in cost, analytics, usage, quota, test, dashboard, and report views.
- [ ] **Step 2: Run** `npm test -- test/admin/cny-currency.test.ts test/admin/model-groups.test.ts` and verify USD/dollar presentation failures.
- [ ] **Step 3: Implement CNY defaults and `¥` rendering** without adding employee sales-price language.
- [ ] **Step 4: Re-run tests and** `npm run admin:build`.

### Task 4: Active Catalog Data and Verification

**Files:**
- Modify: `prisma/seed.ts`
- Test: existing catalog and gateway suites.

**Interfaces:**
- Consumes: official DeepSeek CNY prices.
- Produces: active Pro price `3/6/0.025/6 CNY`, active Flash price `1/2/0.02/2 CNY`, and CNY test schedule rules.

- [ ] **Step 1: Update seed fixtures** to use `CNY` and DeepSeek official RMB price values.
- [ ] **Step 2: Update local active catalog records through application services**, archiving superseded test/current versions while preserving history.
- [ ] **Step 3: Query active prices and scheduled rules** to verify all are `CNY` and exactly one active fallback price exists per DeepSeek model.
- [ ] **Step 4: Run** `npm run verify` and confirm typecheck, all tests, backend build, admin build, and license gate succeed.

## Self-Review

- Spec coverage: procurement prices, scheduled costs, quotas, usage analytics, reports, testing estimates, and admin displays are included.
- Placeholder scan: no deferred implementation steps remain; the only deliberate compatibility boundary is documented in Global Constraints.
- Type consistency: scheduled and fallback snapshots use `CNY`; existing amount property names remain unchanged only at persistence/API compatibility boundaries.
