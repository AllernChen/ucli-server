# 0.9.0 — 组织、部门预算项目与项目 Key 收敛

状态：2026-09-20 已部署公司服务器并通过基础设施、组织数据、项目 Key 与预算烟测。代码完成提交 `4f46311b6bfb37ed288465fb819f5cc4d8e27d28`，发布源提交 `ec2f014253e1a74771363b32a4074a58fe626352`，main 合并提交 `8736f512fb7bc1b057943d970e0b694b6fe24af3`，CI run `35495502573` 三 Job 全绿。

## 变更范围

- 新增组织分类：
  - `EXECUTIVE`：公司经营层；
  - `FUNCTIONAL`：研发部、工程部等职能部门；
  - `REGION`：7 个业务区域部门；
  - `LEGACY_PROJECT`：历史项目组，保留只读兼容。
- 管理端导航从「用量组」改为「组织管理」，旧 `/usage-groups` 地址重定向到 `/org-units`。
- 一个账号仅保留一个 active primary 组织归属。
- 新建组织：公司经营层、工程部；研发部由区域语义修正为职能部门。
- 目标人员归属：
  - 公司经营层：李健、罗晰伊、王宇；
  - 研发部：陈旭均、姚依林、何雪岚、石教帅；
  - 工程部：曹庆杰、陈程浩、汪立波、苗美静；
  - 其余业务员工按现有区域归属收敛为唯一主部门。
- 新增部门预算项目：
  - `DEPT-EXEC` / 公司经营层-部门预算；
  - `DEPT-RD` / 研发部-部门预算；
  - `DEPT-ENG` / 工程部-部门预算。
- 职能部门和经营层成员自动同步为部门预算项目成员。
- 新 Key 签发只接受 `projectId`，必须为非观察者项目成员。
- 网关实时校验项目、所属组织、账号状态与项目成员。
- 移除项目成员会撤销该项目上的有效 Key。
- 项目预算申请支持项目负责人、部门负责人与平台管理员。
- 平台管理员可“提交并批复”，申请记录写入 `selfApproved`。

## 数据库变更

- 新增迁移：`202609200001_org_project_convergence`
- 变更包括：
  - `usage_groups.org_type`；
  - `projects.category`；
  - `group_members.is_primary`；
  - `project_budget_applications.self_approved`；
  - 每账号唯一 active primary 组织归属索引；
  - 每组织唯一 active 部门预算项目索引。
- 迁移会保留历史行，不删除旧表、旧列或旧预算数据。
- 当前生产没有陈程浩账号，迁移会创建无密码账号 `chen02@ucli.local`，显示名“陈程浩”。

## 本地验证

- `npm run verify` 通过：
  - 149 个测试文件；
  - 920 个测试用例；
  - typecheck；
  - 覆盖率门槛；
  - 后端构建；
  - 管理端构建；
  - license gate。
- 覆盖率：
  - statements：93.83%；
  - branches：85.36%；
  - functions：97.34%；
  - lines：93.83%。

## 隔离迁移演练

使用 2026-09-20 当前生产备份恢复到本地 `ucli_org_rehearsal` 后执行全部 21 条迁移。

结果：

```text
active duplicate members = 0
EXECUTIVE organizations = 1
FUNCTIONAL organizations = 2
REGION organizations = 7
DEPARTMENT projects = 3
LEGACY_PROJECT organizations = 14
```

组织快照：

```text
公司经营层
研发部
工程部
北京-GAB区域
广东-东莞区域
广东-市局区域
广东-省厅区域
广东-花都区域
江苏-苏州区域
贵州区域
```

部门项目：

```text
公司经营层-部门预算
研发部-部门预算
工程部-部门预算
```

## 发布件

- 离线包：`ucli-server_0.9.0_20260920_ec2f014.tar.gz`
- 包 SHA-256：`d68cf072a887bc95da7ab3a0e87fc36e726744cec5184df1efb7e6fa8e294148`
- 包大小：208,848,337 bytes
- 包内 8 项 `SHA256SUMS` 全部通过；
- 未包含 `.env`、凭据、私钥或数据库备份；
- runtime 镜像 ID：`sha256:57f959b0d6a0ca667f5d4ac1c60c5f35c0894bf194fdb60b857ef2008361b1ed`
- web 镜像 ID：`sha256:52c2443d2e3a11c0fdacbaf7002037b6644c4da464ecf75fb896b063fa0fba51`

## 公司服务器部署记录（2026-09-20）

- 升级前版本：0.8.2，源提交 `71abff660f3b5d17d7ee2e719beb4d3cb2ee0037`
- 升级前备份：
  - `/data/ucli-server/backups/production-082-71abff6-before-090-8736f5-20260920/`
  - 数据库备份 SHA-256：`3ee3d0db8a002d145ad57bd5cea330f92ab77adc4a275bec8ca41acf6ea862f8`
  - 0.8.2 双镜像归档 SHA-256：`15bd33ff75bdfb50894cd50cb9094cbb884ca1c9da32f2e8d9ba963a6ae618f5`
  - 备份内 7 项 `SHA256SUMS` 全部通过。
- `conf/.env` 仅替换 `VERSION=0.8.2` → `0.9.0`；`MASTER_KEY` 未读取、未展示、未修改。
- `./install.sh update` 先执行迁移，再重建应用容器。
- 迁移 `202609200001_org_project_convergence` 成功应用；当前共 21 条迁移，无待应用迁移。
- 部署后 API / Gateway 健康，PostgreSQL / Redis 均 `ok`，Worker 与 Web 正常运行。
- 四个应用容器均运行 `RELEASE` 中记录的 0.9.0 镜像 ID。
- 外部页面 HTTP 200。

## 生产组织与项目验收

组织快照：

```text
公司经营层 | EXECUTIVE | 3 名成员
工程部 | FUNCTIONAL | 4 名成员
研发部 | FUNCTIONAL | 4 名成员
北京-GAB区域 | REGION
广东-东莞区域 | REGION
广东-市局区域 | REGION
广东-省厅区域 | REGION
广东-花都区域 | REGION
江苏-苏州区域 | REGION
贵州区域 | REGION
研发验收组 | LEGACY_PROJECT
```

部门预算项目：

```text
公司经营层-部门预算 | 3 名成员
工程部-部门预算 | 4 名成员
研发部-部门预算 | 4 名成员
```

平台管理员已通过“提交并批复”为三个部门项目设置初始总额 ¥100：

```text
公司经营层-部门预算：¥100，selfApproved=true
工程部-部门预算：¥100，selfApproved=true
研发部-部门预算：¥100，selfApproved=true
```

## 协议与项目 Key 验收

- 为 `deepseek-v4-flash` 增加 `OPENAI_CHAT` 渠道映射，并配置全天基础价、上午高峰价、下午高峰价。
- 为 11 名部门成员签发部门预算项目 Key：
  - 公司经营层：李健、罗晰伊、王宇；
  - 研发部：陈旭均、姚依林、何雪岚、石教帅；
  - 工程部：曹庆杰、陈程浩、汪立波、苗美静。
- 使用公司经营层新项目 Key 通过 `/gateway/v1/chat/completions` 发起最小 `OPENAI_CHAT` 请求：
  - HTTP 200；
  - 项目预算已结算 ¥0.00003600；
  - 预占为 ¥0；
  - 完整 Key 未输出到日志或回复。
- 撤销最后一把仍活跃且未绑定项目的旧 Key `c69d7cba-0fa2-416b-87af-365c9fff9b64`。
- 当前活跃且未绑定项目的旧 Key 数量为 0。

## 浏览器验收状态

已完成：

- 外部 Web 页面 HTTP 200；
- 管理端构建通过；
- 组织、项目、预算、Key 组件测试通过；
- 生产只读 API 验收通过。

仍建议管理员在浏览器中抽查：

- `/org-units` 组织列表与详情；
- 项目成员添加/移除；
- 项目 Key 查看/复制；
- 预算申请与“提交并批复”记录；
- 员工详情的组织与项目展示。

## 回滚要求

本版包含组织归属和部门项目数据迁移，不能只回滚应用镜像。失败时必须成回滚：

1. 恢复升级前数据库备份；
2. 恢复 0.8.2 runtime 镜像；
3. 恢复 0.8.2 web 镜像；
4. 保留原 `MASTER_KEY`；
5. 验证 0.8.2 API / Gateway 健康。
