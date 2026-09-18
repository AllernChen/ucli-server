# AGENTS.md — UCLI Server

Private-deployed UCLI control plane, model gateway, usage analytics, and skills marketplace. Three NestJS processes (Control API port 3000, Model Gateway port 3001, Worker no HTTP) + Vue 3 admin console (port 5174), on PostgreSQL/Redis/MinIO. Docs and commit messages are in Chinese.

Read before touching sensitive areas: `CONTEXT.md` (domain language — use its terms exactly), `README.md`, `CONTRIBUTING.md`, `docs/ucli-client-protocol.md` (client/device-grant contract), `DEPLOY.md` (deployment contract). Design docs live in `docs/superpowers/` and `docs/adr/`.

## Commands

```bash
npm run verify          # full gate: typecheck + coverage tests + build + admin build + license check
npm run typecheck       # tsc --noEmit
npm test                # vitest run (tests in test/**/*.test.ts, pure Node env — no DB/Redis needed)
npx vitest run test/gateway   # focused tests (any subdir of test/)
npm run build           # tsc -p tsconfig.build.json -> dist/
npm run start:api       # also start:gateway / start:worker; dev:* variants add node --watch
npm run admin:dev       # Vite dev server on 5174
npm run db:generate     # prisma generate (after editing prisma/schema.prisma)
npm run db:migrate      # prisma migrate deploy
docker compose -f docker-compose.dev.yml up -d   # infra: Postgres/Redis/MinIO + Prometheus/Grafana/Loki (127.0.0.1 only)
```

CI runs `verify` + `docker compose build` on every push/PR — must be green.

## Critical rules

- **Never run the apps with `tsx`** — esbuild strips decorator metadata and silently breaks NestJS DI. Apps run from `dist/` (tsc output). Hot reload = `npm run build:watch` in one terminal + `npm run dev:api|gateway|worker` in another.
- **Privacy boundary**: gateway request/response bodies live only in memory. Never log them or persist them; usage logs carry only org/user/device/model/token/cost/latency/status/route fields. No client telemetry.
- **Crypto**: upstream channel keys and device-grant connection URLs are AES-256-GCM encrypted with `MASTER_KEY` (env-injected). `MASTER_KEY` must survive every deploy/restore/upgrade or saved URLs become unreadable.
- **Prisma schema changes** must ship with a migration file in `prisma/migrations/`.
- **No new dependencies** without strong justification; `npm run licenses:check` gates this.
- Testing HTTP with Chinese payloads: use Node `fetch` scripts — PowerShell `Invoke-RestMethod` corrupts UTF-8.

## Architecture

```
apps/api      # Control API — flat *.controller.ts / *.service.ts / *.dto.ts per feature
apps/gateway  # Model gateway — thin: controller -> gateway.service -> packages/gateway-core
apps/worker   # Scheduled jobs / usage aggregation (BullMQ)
apps/admin    # Vue 3 <script setup>, dark theme per apps/admin/src/styles.css & forms.css
packages/     # Shared libs: gateway-core, security, quota, http, monitoring, storage, database, skills, reports, usage
```

- Layering in API: controller → service → Prisma (`@ucli/*` path alias maps `packages/*/src`).
- API conventions: `:id` params go through `UuidPipe`; Prisma errors are mapped by the global exception filter — keep error semantics consistent.
- Gateway protocols selectable by clients: `openai_responses`, `openai_chat`, `anthropic_messages`. `GEMINI` is an internal upstream/conversion protocol only — never expose it as a client-facing protocol.
- Coverage thresholds (enforced in `verify`): lines/statements ≥ 80%, functions/branches ≥ 75% over packages/gateway-core|security|quota|skills|reports|usage|http|monitoring.

## Conventions

- Commit messages in Chinese, explain "why", prefix `feat:` / `fix:` / `docs:` / `ci:` / `chore:` / `test:`.
- TypeScript strict mode everywhere.
- Production deploys: Linux x86_64 Docker; use the `deploy-ucli-company-server` skill (`.agents/skills/`) and follow `DEPLOY.md` — never bypass `install.sh` migration ordering.
