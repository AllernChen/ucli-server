# UCLI Server

UCLI Server 是面向私有部署的 UCLI 控制面、模型网关、使用分析和技能超市。平台只统计经过自身网关的模型调用，不接收客户端遥测，也不保存模型请求或响应正文。

仓库包含三个 NestJS 进程（Control API、Model Gateway、Worker）、Vue 管理后台、PostgreSQL/Redis/MinIO 数据层，以及 Prometheus/Loki/Grafana 运维监控。

## 开发

### 基础设施（Docker）

PostgreSQL/Redis/MinIO 与监控栈（Prometheus/Grafana/Loki）由 `docker-compose.dev.yml` 编排（端口仅绑定 127.0.0.1，避开本机其它项目占用）：

```powershell
Copy-Item .env.example .env
npm install
npm run db:generate
docker compose -f docker-compose.dev.yml up -d
npm run db:migrate
```

### 启动服务

```powershell
npm run build          # tsc 编译到 dist/
npm run start:api      # 控制面   http://localhost:3000  (/docs Swagger, /healthz)
npm run start:gateway  # 模型网关  http://localhost:3001  (/healthz)
npm run start:worker   # 定时任务/聚合 Worker（无 HTTP）
npm run admin:dev      # 管理后台  http://localhost:5174
```

> `start:*` 与 `dev:*` 运行的是 `tsc` 编译产物 `dist/`，不要用 `tsx` 跑应用——tsx 不生成 decorator metadata，会静默破坏 NestJS 依赖注入。

热重载：一个终端 `npm run build:watch`（tsc 监听重编译），另开 `npm run dev:api` / `dev:gateway` / `dev:worker`（node --watch 重启）。

`.env` 已含 `NO_COLOR=1`，让 NestJS 日志不带 ANSI 颜色，供 Loki 干净采集。

### 首次初始化与后台配置

先初始化平台管理员（`X-UCLI-Setup-Secret` 值来自 `.env` 的 `SETUP_SECRET`），再用该账号登录后台：

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/auth/setup `
  -Headers @{ "X-UCLI-Setup-Secret" = "<SETUP_SECRET>" } -ContentType "application/json" `
  -Body '{"email":"admin@example.com","password":"...","displayName":"Admin","organizationName":"MyOrg"}'
```

后台配置顺序：**渠道与 Key**（新建渠道 → 添加上游 API Key → 测试）→ **模型目录**（新建模型 → 加能力[渠道/上游模型/协议] → 加定价 → 发布）→ 网关即可转发，用量见 **使用日志** 与 **运营报告**。

### 本地监控

- Prometheus：http://localhost:9090 —— 抓取 api/gateway `/metrics`（含 `ucli_http_requests_total` 请求级指标）
- Grafana：http://localhost:3002 —— `admin` / `.env` 的 `GRAFANA_ADMIN_PASSWORD`，预置「UCLI 请求监控」面板（QPS / P95 延迟 / 5xx / 按路由）
- Loki：http://localhost:3100 —— promtail 采集 `dev-logs/*.log`，Grafana Explore 用 `{job="ucli-dev"}` 查询

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
