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

后台配置顺序：**渠道与 Key**（新建渠道 → 添加上游 API Key）→ **渠道模型**（映射公共模型/上游模型/协议 → 测试健康）→ **采购成本**（维护公共兜底价、渠道基础价与分时覆盖价）→ **模型目录**（发布检查 → 发布）→ 网关即可转发。实时用量与公司采购成本见 **统计分析**，周期归档见 **运营报告**。

服务端模型目录通过 `protocols` 声明每个模型可调用的 Gateway 协议。UCLI 必须按 `openai_responses`、`openai_chat` 或 `anthropic_messages` 能力选择模型和端点，不能假设列表首个模型支持 Responses；`GEMINI` 是服务端内部上游/转换协议，仅贡献 `openai_chat`，不是 UCLI 可选择的原生 Gateway 协议。

### 渠道模型运营

- 渠道详情集中维护上游模型映射、Key 和模型级健康记录；采购成本摘要可深链到独立的“采购成本”工作台。
- 采购成本工作台按厂家、公共模型和渠道模型聚合，提供周时间轴、当前来源、下次切换、规则模板、冲突预览和时间点 Token 试算；试算输入按渠道成本时区解释，不受管理员浏览器时区影响。
- 采购成本按渠道时区、星期和分钟区间匹配；渠道分时规则覆盖基础成本，未命中时使用公共模型兜底价。金额仅用于公司内部预算控制和成本统计，不维护员工销售价，也不计算收入或利润。
- Worker 每分钟扫描到期的渠道模型探测任务（单批最多 30 个、并发 3），探测记录保留 30 天。
- **模型测试**支持固定渠道模型的多轮对话，不做故障切换；测试消息只保存在浏览器内存，不写入数据库。
- **统计分析**提供组织、渠道、公共模型、渠道模型、员工和成本规则维度的请求量、Token、成功率、延迟与采购成本分析。

### 本地监控

- Prometheus：http://localhost:9090 —— 抓取 api/gateway `/metrics`（含 `ucli_http_requests_total` 请求级指标）
- Grafana：http://localhost:3002 —— `admin` / `.env` 的 `GRAFANA_ADMIN_PASSWORD`，预置「UCLI 请求监控」面板（QPS / P95 延迟 / 5xx / 按路由）
- Loki：http://localhost:3100 —— promtail 采集 `dev-logs/*.log`，Grafana Explore 用 `{job="ucli-dev"}` 查询

API 文档位于 `/docs`，桌面端接入说明见 [docs/ucli-client-protocol.md](docs/ucli-client-protocol.md)，供应商接入示例见 [docs/providers.md](docs/providers.md)。

## 环境要求

生产部署目标为 Linux x86_64，要求 Docker Engine 24+ 与 Docker Compose v2，并可访问既有 PostgreSQL、Redis、MinIO 外部网络。完整端口、网络、备份和回滚要求见 `DEPLOY.md`。

## 快速开始（私有化部署）

生成随机配置并启动：

```sh
cp .env.example .env
# 修改所有密码；MASTER_KEY 使用 openssl rand -base64 32
docker compose up -d --build
```

首次初始化调用 `POST /api/v1/auth/setup` 时必须携带 `X-UCLI-Setup-Secret` 请求头，值来自 `SETUP_SECRET`。初始化完成后应轮换该密钥。

首次启动后调用 `POST /api/v1/auth/setup` 创建首个组织和平台管理员。后续用户由平台预创建普通成员；设备授权资格不由角色限制，启用的 `PLATFORM_ADMIN`、`ORG_ADMIN` 和 `MEMBER` 都可以获得授权。平台管理员或组织管理员仅在自己可管理的组织范围内，为任一启用账号的每台设备创建授权（一台设备一条授权）；用户通过浏览器授权链接连接 UCLI。旧邀请和设备码流程不再兼容，具体桌面端接入见 [协议](docs/ucli-client-protocol.md)。

### 设备授权链接操作

- 新创建的连接 URL 默认有效 7 天；授权本身默认永久有效。链接 URL 有效期与授权有效期相互独立，管理员可分别修改授权有效期或重新生成 URL。
- 管理员可以查看当前 URL；重新生成链接会立即使上一个链接失效，并发放一个新的默认 7 天 URL。URL 过期、撤销或已使用时，使用“重新生成链接”恢复连接，不会改变授权的有效期。
- 授权一旦被设备兑换即进入已绑定状态，不能再为其他设备生成或兑换 URL。需要更换设备时，请按运营政策新建设备授权。
- 连接 URL 使用 `MASTER_KEY` 加密后保存，且只在创建、查看或重新生成操作中显示。部署、恢复和滚动升级必须保持同一 `MASTER_KEY`，否则已保存的连接 URL 无法读取或重新显示。

## 安全边界

- 上游 Key 和连接 URL 使用 AES-256-GCM 加密，主密钥仅由环境注入。
- 请求正文只在网关内存中转发，不进入使用日志和应用日志。
- 使用日志只记录组织、账号、设备、匿名会话/项目、模型、Token、费用、延迟、状态和路由信息。
- New API 不属于依赖或分发物，详情见 [ADR-0001](docs/adr/0001-independent-gateway.md)。
