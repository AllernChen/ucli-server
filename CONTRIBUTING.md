# 贡献指南

欢迎参与 UCLI Server 开发。请先阅读 [README.md](README.md) 了解项目定位与本地开发环境搭建。

## 目录结构

```
apps/
  api/       # 控制面（NestJS，端口 3000，/docs Swagger）
  gateway/   # 模型网关（NestJS，端口 3001）
  worker/    # 定时任务 / 用量聚合（无 HTTP）
  admin/     # Vue 3 管理后台（vite dev 端口 5174）
packages/    # 共享库：gateway-core / security / quota / http / monitoring / storage / database / skills / reports / usage
prisma/      # 数据库 schema 与迁移
deploy/      # 部署配置：nginx / prometheus / grafana / promtail（含 dev 与生产两套）
scripts/     # deploy.ps1 / backup.ps1 / restore.ps1 / check-licenses.mjs
```

## 本地开发

基础设施与监控由 `docker compose -f docker-compose.dev.yml up -d` 编排，详见 README「开发」章节。

> ⚠️ **不要用 `tsx` 直接跑应用**——tsx(esbuild) 不生成 decorator metadata，会静默破坏 NestJS 依赖注入。`start:*`/`dev:*` 脚本运行的是 `tsc` 编译产物 `dist/`；热重载用 `npm run build:watch` + `npm run dev:*`。

## 代码规范

- TypeScript 严格模式；NestJS 控制器/服务遵循现有分层（controller → service → prisma）。
- 管理后台 Vue 3 `<script setup>`，样式遵循 `styles.css` / `forms.css` 的暗色主题约定。
- 不引入新的依赖除非确有需要；许可证由 `npm run licenses:check` 把关。
- API 路由、错误语义保持与现有约定一致（如 `:id` 走 `UuidPipe`，Prisma 错误由全局过滤器映射）。

## 测试

- 单元测试：`npm test`（vitest，纯 Node 环境，不需要 DB/Redis）。
- 覆盖率：`npm run test:coverage`，**门槛 lines/statements ≥ 80%、functions/branches ≥ 75%**，范围为核心业务模块（gateway-core/security/quota/skills/reports/usage/http/monitoring）。低于门槛 `verify` 会失败。
- 新功能应配套测试（网关核心逻辑、安全、http 管道、monitoring 等）。
- 端到端验收可用 playwright CLI 走浏览器流程（管理后台）或 Node `fetch` 脚本（含中文请求务必用 Node，PowerShell `Invoke-RestMethod` 会把中文编码坏）。

## 提交前检查

```powershell
npm run verify   # typecheck + 测试(覆盖率) + build + admin:build + licenses
```

## 提交与 PR

- 提交信息用中文，描述「为什么」：`feat:` / `fix:` / `docs:` / `ci:` / `chore:` / `test:` 前缀。
- 改动直接推 `main` 或开 PR 均可（PR 请按 `.github/pull_request_template.md` 填写）。
- CI 会在 push/PR 时运行 `verify` + `docker compose build`，需全绿。
- 涉及数据库 schema 变更时，同时提供 Prisma migration。

## 部署

- 生产部署：`powershell -File scripts/deploy.ps1`（构建 + 启动 `-p ucli-prod`，自动处理 Grafana 端口冲突与健康检查）。
- 生产环境安全要点：`SETUP_SECRET` 初始化后应轮换；管理员密码用强密码（后台可在线修改）。
