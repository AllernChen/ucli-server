# 0.9.2 — Key 明文查看补齐与预算占比分析

状态：2026-09-20 已部署公司服务器并通过基础设施与 API 验收；浏览器人工验收待完成。

## 变更范围

- 个人中心和管理端的员工 Key 详情均支持密码验证明文查看：
  - 个人中心验证当前登录密码；
  - 管理端验证管理员密码；
  - 仅可恢复密文可查看；
  - 响应不落缓存并写入审计。
- 员工 Key 列表新增累计请求、Token、成本、项目预算占比和项目用量占比。
- 项目 Key 列表新增累计用量、成本、项目预算占比和项目用量占比。
- 组织详情成员列表新增关联项目数、有效 Key 数、近 30 天 Token、成本、成员用量占比、预算占比和预算使用情况。

## 验证

- typecheck 通过。
- 员工 Key、项目和组织相关定向测试通过。
- 管理端构建通过。
- CI `35501761420` 在源码提交 `1df27fa57e692bd2eb59a813f23bb5896f8a1a08` 上三项 job 全绿：
  [CI 运行记录](https://github.com/AllernChen/ucli-server/actions/runs/35501761420)。

## 发布件

- 离线包：`F:\projects\ucli-server\releases\ucli-server_0.9.2_20260920_1df27fa.tar.gz`
- 离线包大小：`208,896,668` 字节
- 离线包 SHA-256：`523171e65cd7370f1213bb583dd7aec6370fdc831668855373e6cbbe4cfae915`
- Runtime 镜像：`ucli-server-runtime:0.9.2`
  `sha256:d1195b94fb1f408dce3db73f6f3bc16c627151ce88f3b349afcc0b7ab16ec138`
- Web 镜像：`ucli-server-web:0.9.2`
  `sha256:f8e03d3d8df67a54061956ec7bb94467f254ca8ae739230d41dea7458d37c614`
- 包内校验通过；未包含 `.env`、数据库备份、凭据或私钥。

## 公司部署记录

- 部署时间：2026-09-20。
- 目标：`http://10.44.100.100`，部署目录 `/data/ucli-server`。
- 升级前版本：`0.9.1`，源码提交 `985947a81457a47d4e9d209455e15fda88a6b915`。
- 升级后版本：`0.9.2`，源码提交 `1df27fa57e692bd2eb59a813f23bb5896f8a1a08`。
- 升级前成对备份：
  `/data/ucli-server/backups/production-091-985947a-before-092-1df27fa-20260920`。
  - PostgreSQL 备份 `ucli.dump`
    SHA-256：`f5e8d7493d527b8b197a58fba7398960cb52169986399af9d450fddd97cdaec6`
  - 0.9.1 镜像归档 `ucli-server-0.9.1-images.tar.gz`
    SHA-256：`d0ab6c47655b322a68c5ce70c57ddffb2b5135388021f4bd359d17aa76ff9ed8`
  - 发布控制文件、镜像清单、容器状态与全套 SHA-256 已随备份保留。
- 执行方式：`./install.sh update`。
- 迁移结果：21 个迁移已加载，无待执行迁移。
- 部署后 API healthz：`ok`，PostgreSQL 与 Redis 均为 `ok`。
- 部署后 Gateway healthz：`ok`，PostgreSQL 与 Redis 均为 `ok`。
- 外部页面 `http://10.44.100.100/` 返回 HTTP 200。
- 四个应用容器均运行 0.9.2；runtime 镜像 ID 与 Web 镜像 ID 和发布件一致。

## 生产验收

### Key 明文查看

- 管理端员工 Key 明文查看通过：验证管理员密码成功，返回密钥格式与长度有效，完整明文未写入日志或文档。
- 个人中心自有 Key 明文查看通过：验证当前登录密码成功，返回密钥格式与长度有效。

### 组织与项目分析

- 组织详情成员接口确认包含关联项目数、有效 Key 数、近 30 天请求/Token/成本、最近使用时间、成员用量占比、预算占比以及组织预算总额/已占用/可用/使用百分比。
- 项目预算接口确认包含额度、已用、预占、待核算与可用字段；前端进度按上述字段计算。
- 项目 Key 列表确认包含请求、Token、成本、项目预算 Key 成本占比与项目用量占比。
- `org-project-access-coverage.mjs --dry-run` 显示 87 个目标关系；缺失项目成员 0，缺失有效 Key 0。

## 剩余事项

- 浏览器人工验收待完成，重点复核组织列表/详情、项目概述、项目 Key、用户管理 Key 详情和个人中心 Key 详情的展示、复制与关闭清屏行为。

## 回滚

无数据库迁移。如需回滚，恢复 0.9.1 数据库备份和 runtime/web 镜像，并保留原 `MASTER_KEY`。
