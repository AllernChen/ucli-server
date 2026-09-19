# 0.8.0 — 区域用量组、项目管理与项目预算

状态：2026-09-19 已部署公司服务器并完成第一批区域项目数据迁移。实现源提交 `1e86705e9d3e9ff0a9746c953cb0a493b8b7089a`，CI run `35425715470` 三 Job 全绿。

## 变更范围

- 用量组新增 `REGION` 类型；活动业务组收敛为 7 个区域组。
- 新增项目管理、项目职责成员、项目化员工 API Key 和项目化设备授权。
- 新增项目独立预算池、预留/结算账本、调整流水和申请批复。
- 区域页展示项目标签和下属项目预算汇总；区域本身不扣预算。
- 网关凭项目 Key 或项目化设备授权归因；不读取 `X-UCLI-Project-Id`。
- 统计分析支持区域汇总和项目下钻，历史旧组通过 `Project.sourceGroupId` 映射。
- 新增 `scripts/migrate-region-projects.mjs`，默认干跑，`--apply` 后迁移公司数据并替换 23 把项目 Key。

## 数据模型

- 新增 `projects`、`project_members`、`project_budget_periods`、`project_budget_entries`、`project_budget_applications`。
- `employee_api_keys`、`device_grants`、`usage_logs` 增加项目关系字段。
- `UsageGroupType` 新增 `REGION`。

## 发布前必做

1. 冻结写入并创建完整生产数据库备份。
2. 确认当前版本为 0.7.1 且迁移基线为 19 条。
3. 上传并校验 0.8.0 离线包。
4. 使用 `./install.sh update` 先迁移后启动。
5. 迁移后确认 20 条迁移全部应用。
6. 用迁移脚本先干跑；确认 7 区域、13 项目、46 归属、23 替换 Key 后再 `--apply`。
7. 保存新 Key 发放清单；旧 Key 切换完成后撤销。
8. 验证 API/Gateway 健康、四个容器镜像、项目管理页、项目预算和网关扣费。

## 回滚边界

- 本迁移为附加式 schema 变更，不删除历史数据。
- 项目化业务回滚必须同时恢复升级前数据库备份、0.7.1 应用镜像和原 `MASTER_KEY`。
- 不支持只回滚应用镜像而保留新业务数据。

## 验收门禁

- 全量 `npm run verify` 通过。
- CI `verify`、`group-integration`、`docker-build` 全绿。
- 本地空库迁移链前滚通过。
- 项目预算不足返回 `429 project_budget_exceeded`。
- 项目 Key/设备授权不依赖项目请求头。
- 请求和响应正文仍不落盘。

## 公司服务器迁移记录（2026-09-19）

- 升级前备份：`/data/ucli-server/backups/production-071-29759da-before-080-983f493-20260919/`。
- 数据库备份 SHA-256：`db35b703ed60b357ffae3e93c846acca29a650e13038d9834f2947961ca8ae50`。
- 0.7.1 镜像归档 SHA-256：`9e85144c09fea27e597d23f226a74eeea0c82e20de14e5d8563405f5f1d322ba`。
- `conf/.env` 仅字节级替换 `VERSION=0.7.1` → `0.8.0`；`MASTER_KEY` 未读取、未展示、未修改。
- `./install.sh update` 先加载镜像、迁移后启动；迁移总数增至 20 条并全部成功。
- 迁移脚本完成 7 区域、13 项目、46 条区域归属、23 把项目 Key 替换，13 个旧项目组已归档。
- 部署后 API/Gateway 健康，PostgreSQL/Redis 均 `ok`；外部页面 HTTP 200。