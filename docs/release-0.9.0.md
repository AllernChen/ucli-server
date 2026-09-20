# 0.9.0 — 组织、部门预算项目与项目 Key 收敛

状态：2026-09-20 代码与隔离迁移演练完成，待发布公司服务器。实现源提交 `4f46311b6bfb37ed288465fb819f5cc4d8e27d28`。

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

待最终打包后补充：

- 离线包路径；
- 包 SHA-256；
- runtime 镜像 ID；
- web 镜像 ID；
- `SHA256SUMS` 校验结果。

## 公司服务器部署记录

待部署后补充：

- 升级前备份路径与哈希；
- 迁移执行结果；
- 容器健康检查；
- 组织快照；
- 部门预算批复记录；
- 替换 Key 数量；
- 旧 Key 撤销结果；
- 浏览器验收结果。

## 回滚要求

本版包含组织归属和部门项目数据迁移，不能只回滚应用镜像。失败时必须成回滚：

1. 恢复升级前数据库备份；
2. 恢复 0.8.2 runtime 镜像；
3. 恢复 0.8.2 web 镜像；
4. 保留原 `MASTER_KEY`；
5. 验证 0.8.2 API / Gateway 健康。
