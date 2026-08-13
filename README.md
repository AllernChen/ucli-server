# UCLI Server

UCLI Server 是面向私有部署的 UCLI 控制面、模型网关、使用分析和技能超市。平台只统计经过自身网关的模型调用，不接收客户端遥测，也不保存模型请求或响应正文。

仓库包含三个 NestJS 进程（Control API、Model Gateway、Worker）、Vue 管理后台、PostgreSQL/Redis/MinIO 数据层，以及 Prometheus/Loki/Grafana 运维监控。

## 开发

```powershell
Copy-Item .env.example .env
npm install
npm run db:generate
npm test
npm run typecheck
npm run build
npm run admin:build
```

本地服务需要 PostgreSQL、Redis 和 MinIO。分别运行（`start:*` 与 `dev:*` 均运行 `tsc` 编译产物 `dist/`，非 `tsx`——tsx 不生成 decorator metadata，会破坏 NestJS 依赖注入）：

```powershell
npm run start:api
npm run start:gateway
npm run start:worker
npm run admin:dev
```

热重载开发：一个终端跑 `npm run build:watch`（tsc 监听重编译），另开终端跑 `npm run dev:api` / `dev:gateway` / `dev:worker`（node --watch 重启）。

API 文档位于 `/docs`，桌面端接入说明见 [docs/ucli-client-protocol.md](docs/ucli-client-protocol.md)。

## 私有化部署

生成随机配置并启动：

```sh
cp .env.example .env
# 修改所有密码；MASTER_KEY 使用 openssl rand -base64 32
docker compose up -d --build
```

首次初始化调用 `POST /api/v1/auth/setup` 时必须携带 `X-UCLI-Setup-Secret` 请求头，值来自 `SETUP_SECRET`。初始化完成后应轮换该密钥。

首次启动后调用 `POST /api/v1/auth/setup` 创建首个组织和平台管理员。后续用户通过管理员邀请加入。

## 安全边界

- 上游 Key 使用 AES-256-GCM 加密，主密钥仅由环境注入。
- 请求正文只在网关内存中转发，不进入使用日志和应用日志。
- 使用日志只记录组织、账号、设备、匿名会话/项目、模型、Token、费用、延迟、状态和路由信息。
- New API 不属于依赖或分发物，详情见 [ADR-0001](docs/adr/0001-independent-gateway.md)。
