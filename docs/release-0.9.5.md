# 0.9.5 — 个人中心用量总览

状态：2026-09-21 已部署公司服务器并通过基础设施与 API 验收；浏览器人工验收待完成。

## 变更范围

- 个人中心“我的用量”新增总体卡片：
  - 可访问项目总额度、可用额度和不限额项目数；
  - 项目当前预算周期的已用、预占、已用 + 预占和总体使用率；
  - 当前查询时间范围内自己的请求、Token、成本，以及自己占项目总额度的比例。
- 新增“所在项目用量汇总”：
  - 仅展示本人可访问的活跃项目；
  - 每个项目展示额度、已用、预占、可用、使用率；
  - 展示本人在查询时间内的请求、Token、成本；
  - 计算本人占项目额度比例和占项目已用 + 预占比例。
- 新增“我的 API Key 使用情况”：
  - 列出本人全部未删除 Key，包括无用量 Key；
  - 展示 Key、项目、状态、请求、Token、成本、最后使用时间；
  - 计算 Key 占本人用量比例和占项目额度比例。
- 保留按组织汇总、使用日志和统计分析入口。
- `GET /api/v1/me/profile/usage` 在兼容原 `overview` / `groups` 字段的基础上新增 `summary`、`projects`、`keys`。

## 验证

- typecheck 通过。
- 个人中心界面测试通过。
- PostgreSQL 集成测试验证项目预算、本人项目用量、两个 Key 的用量和占比。
- 管理端构建通过。
- 完整 `verify` 门禁通过：930 项测试全部通过，语句/行覆盖率 93.83%，分支 85.34%，函数 97.34%。
- 许可证检查通过。
- CI `35556492349` 在源码提交 `77451f7f8caedf0ed1b7ec5714f8f6994bdb0aa9` 上三项 job 全绿：
  [CI 运行记录](https://github.com/AllernChen/ucli-server/actions/runs/35556492349)。

## 发布件

- 离线包：`F:\projects\ucli-server\releases\ucli-server_0.9.5_20260921_77451f7.tar.gz`
- 离线包大小：`211,109,790` 字节
- 离线包 SHA-256：`25aaee1f0f8dffa82a877dab6b7b2c5641b98181e52a4a992710c95e3963f21a`
- Runtime 镜像：`ucli-server-runtime:0.9.5`
  `sha256:9c6d718b52f5247c0ad2291ede79c1c7d63767b5c5c5fa4c88157fc897c950ca`
- Web 镜像：`ucli-server-web:0.9.5`
  `sha256:7e979c42530187b3b0a2514bf18eaa18358a524486c31d6d6cb3f48e0ef3acc1`
- 包内校验通过；未包含 `.env`、数据库备份、凭据或私钥。

## 公司部署记录

- 部署时间：2026-09-21。
- 目标：`http://10.44.100.100`，部署目录 `/data/ucli-server`。
- 升级前版本：`0.9.4`，源码提交 `0cd5808afe319ed16204965566bc6fb8c9abe3be`。
- 升级后版本：`0.9.5`，源码提交 `77451f7f8caedf0ed1b7ec5714f8f6994bdb0aa9`。
- 升级前成对备份：
  `/data/ucli-server/backups/production-094-0cd5808-before-095-77451f7-20260921`。
  - PostgreSQL 备份 `ucli.dump`
    SHA-256：`10e9f8d94def3404434082bcdaf67b09114ce263f4b094a59a46bddc37f06fab`
  - 0.9.4 镜像归档 `ucli-server-0.9.4-images.tar.gz`
    SHA-256：`bf8154f6859026183de864f685724451d5cad32b3953a57c716a0b1195f67c39`
  - 发布控制文件、镜像清单、容器状态与全套 SHA-256 已随备份保留。
- 执行方式：`./install.sh update`。
- 迁移结果：21 个迁移已加载，无待执行迁移。
- 部署后 API healthz：`ok`，PostgreSQL 与 Redis 均为 `ok`。
- 部署后 Gateway healthz：`ok`，PostgreSQL 与 Redis 均为 `ok`。
- 外部页面 `http://10.44.100.100/` 返回 HTTP 200。
- 四个应用容器均运行 0.9.5；runtime 镜像 ID 与 Web 镜像 ID 和发布件一致。

## 生产验收

- 生产 API `GET /api/v1/me/profile/usage` 返回 `summary`、`projects`、`keys`、`overview` 和 `groups`。
- 抽样账号返回 2 个可访问项目、7 个 Key；项目行包含预算、本人用量和占比字段，Key 行包含用量、项目和占比字段。
- 生产前端懒加载 `Profile-CFofIiMS.js` 包含“所在项目用量汇总”和“我的 API Key 使用情况”。

## 剩余事项

- 浏览器人工验收待完成：用普通员工账号进入个人中心 → 我的用量，检查总额度、已用 / 预占、项目表、Key 表和占比展示。

## 回滚

无数据库迁移。如需回滚，恢复 0.9.4 数据库备份和 runtime/web 镜像，并保留原 `MASTER_KEY`。
