# 区域用量组与项目预算设计方案

状态：设计 v2，核心决策已确认；尚未实施，未修改公司环境。

## 1. 已确认决策

| 决策 | 结论 |
|---|---|
| 区域粒度 | 采用 **7 个业务区域**，不合并为省份级 4 区 |
| 预算主体 | **项目预算为主**；区域不设独立预算池，只做项目汇总 |
| 项目归因 | 区域内请求 **必须归属一个项目**，不允许“区域未分配项目”消耗 |
| 项目访问 | **区域成员默认可选区域内全部项目** |
| 项目 Key | 区域成员默认拥有区域内全部项目的 Key 资格；实际密钥仍需签发并一次性展示 |
| 请求头方案 | **不采用 `X-UCLI-Project-Id` 请求头选择项目**；项目归因必须内嵌在凭据中 |

## 2. 背景与目标

当前公司环境已按 13 个项目型用量组完成第一批初始化。实际管理中发现：项目粒度过细，成员复用、Key 分发和预算查看都要在多个相似组之间操作，管理成本偏高。

本设计将管理视角改为「**区域 → 项目**」：

- **区域用量组**：成员、负责人、模型权限、区域汇总和项目组织边界；
- **项目**：区域下的一等实体，拥有稳定 ID、状态、负责人、预算和用量账本；
- **项目 Key**：同时绑定员工、区域和项目的员工 API Key；网关凭 Key 直接确定项目，不依赖请求头；
- **项目预算**：唯一的业务预算主体；区域页展示下属项目预算合计和使用情况；
- **用量展示**：用量组列表按 7 个区域展示，项目作为标签和下钻维度。

## 3. 区域与项目划分

| 区域用量组 | 项目 | 当前临时额度合计 |
|---|---|---:|
| 广东-省厅区域 | 省厅、机场、地市 | ¥1,250 |
| 广东-市局区域 | 市局、越秀、黄埔、揭阳、交警 | ¥6,900 |
| 广东-花都区域 | 花都 | ¥200 |
| 广东-东莞区域 | 东莞 | ¥2,900 |
| 北京-GAB区域 | GAB | ¥2,050 |
| 江苏-苏州区域 | 苏州 | ¥250 |
| 贵州-贵州 | 贵州 | ¥100 |

合计 ¥13,650。迁移时，13 个旧项目组的当前额度转为对应项目的初始项目预算；区域额度只是下属项目额度合计，不创建区域扣费池。

## 4. 核心领域模型

```text
Organization
  └── UsageGroup(type=REGION)       // 区域：成员、负责人、模型权限
        ├── GroupMember
        ├── GroupModelAccess
        └── Project
              ├── ProjectMember      // 项目职责/负责人，不是访问门槛
              ├── ProjectBudgetPeriod / Entry
              └── ProjectBudgetApplication

EmployeeApiKey
  → UsageGroup(区域)
  → Project(必填)

DeviceProjectCredential / ProjectScopedDeviceGrant
  → UsageGroup(区域)
  → Project(必填)

UsageLog
  → UsageGroup(区域快照)
  → BudgetProject(项目快照，必填)
```

### 4.1 区域用量组

- 复用现有 `UsageGroup`、`GroupMember`、`GroupModelAccess`、员工 Key、设备授权和网关访问检查；
- `UsageGroupType` 增加 `REGION`；
- 活动业务组统一为 `REGION`；
- 区域负责人继续使用 `GroupMember.role=LEADER`；
- 区域控制模型白名单和成员资格；
- 区域不控制预算扣减，只汇总下属项目。

### 4.2 项目

新增 `Project`：

| 字段 | 说明 |
|---|---|
| `organizationId` | 组织边界 |
| `regionId` | 所属区域 `UsageGroup`，必填 |
| `code` | 组织内唯一短码，例如 `GD-PROV-SLT` |
| `name` | 展示名，例如「省厅」 |
| `description` | 项目说明 |
| `status` | `ACTIVE` / `SUSPENDED` / `ARCHIVED` |
| `sourceGroupId` | 迁移来源旧项目组 ID，用于历史统计映射 |
| `budgetMode` | `TOTAL` 或 `MONTHLY` |
| `budgetTimezone` | 默认 `Asia/Shanghai` |

项目删除一律归档，保留预算和用量历史。

### 4.3 项目职责成员

`ProjectMember` 记录项目负责人和项目职责：

- `OWNER`：项目负责人，可查看项目预算/用量并提交预算申请；
- `CONTRIBUTOR`：项目参与者，用于项目通讯录和报表；
- `VIEWER`：只读观察者，可选。

按已确认决策，`ProjectMember` **不是访问权限门槛**。只要账号是活动区域成员，就默认获得该区域下全部活动项目的 Key 签发资格。

## 5. 项目 Key 设计

### 5.1 凭据即归因

不使用请求头选择项目。员工 API Key 增加必填 `projectId`：

```text
EmployeeApiKey
  organizationId
  accountId
  groupId      // 区域组
  projectId    // 项目
  name         // 区域-项目-姓名
  secretHash
```

网关认证 Key 后即可同时得到：

- 员工；
- 区域；
- 项目；
- 模型访问范围；
- 项目预算池。

AI CLI / 开发工具只需像现在一样配置 Base URL 和 API Key，不需要额外设置项目请求头。

### 5.2 默认资格与实际签发

区域成员默认拥有区域内全部活动项目的 Key 资格：

- 新员工加入区域后，立即可签发该区域全部项目 Key；
- 新项目创建后，该区域全部成员立即可签发该项目 Key；
- 平台不静默生成密钥，因为完整 Key 只能展示一次；界面提供「批量签发」和「按人按项目签发」；
- 未签发只表示“没有密钥”，不表示“没有资格”；
- 管理端展示每个区域的 Key 覆盖率：已签发 / 可签发。

### 5.3 生命周期

- 员工移出区域：自动撤销该员工在区域下全部项目 Key；
- 项目停用或归档：拒绝新请求，历史 Key 和历史日志保留；
- 项目恢复：原 Key 可恢复或重新签发；
- Key 命名建议：`区域-项目-姓名`；
- 一名员工在多个项目工作可持有多把项目 Key，凭不同 Key 明确成本归属；
- 完整密钥仍只在创建时展示一次，不写日志、不写审计 metadata。

### 5.4 设备授权兼容

设备授权也必须项目化，不能只归区域：

- 新设备授权签发时必须选择项目；
- 设备 Token / Refresh Token 携带项目和区域声明；
- 网关凭 Token 中的项目声明扣项目预算，不读取请求头；
- 同一设备若要服务多个项目，需要支持多个项目化授权或项目凭据声明；实施前必须复核现有 `DeviceGrant.deviceId` 唯一约束；
- 存量区域型设备授权在迁移窗口重新签发，不直接改写历史归属。

## 6. 项目预算设计

### 6.1 唯一预算主体

只创建项目预算池，不创建区域预算池：

```text
ProjectBudgetPeriod
  projectId
  periodKey
  limitCny
  spentCny
  reservedCny

ProjectBudgetEntry
  projectId / periodId
  requestId
  status
  reservedCny / settledCny
```

现有组预算的预留、结算、异常恢复、幂等和调整流水逻辑应抽取复用，但不复制两套实现。

### 6.2 区域汇总

区域页动态汇总：

```text
区域额度 = SUM(活动项目额度)
区域已消耗 = SUM(项目已消耗)
区域预留 = SUM(项目预留)
区域可用 = SUM(项目可用)
```

区域不参与扣费，不产生双重预算检查。

### 6.3 项目预算约束

- 每次可计费请求必须先锁定项目预算；
- 项目预算不足返回 `429 project_budget_exceeded`；
- 不存在区域额度绕过项目限额的路径；
- 80% / 100% 告警按项目触发；
- 区域告警只做汇总提示，不阻断请求。

### 6.4 项目预算申请

项目详情支持：

- 项目负责人提交预算申请；
- 管理员批复并关联额度调整；
- 申请、批复、调整流水互查；
- 已决定申请不可重复批复。

## 7. 用量日志与统计

### 7.1 日志字段

新增：

```text
budgetProjectId   // 真实预算项目 ID，外键
projectNameSnapshot
regionNameSnapshot
```

现有 `UsageLog.projectId` 保留为历史客户端上下文字段，但新预算归因不使用它。

新日志必须满足：

- `groupId` = 凭据所属区域；
- `budgetProjectId` = 凭据绑定项目；
- 两个字段都在请求开始时快照，请求期间人员调组、项目停用不改写本次归属。

### 7.2 统计口径

- 区域汇总：按 `groupId` 或 `Project.regionId` 聚合；
- 项目明细：按 `budgetProjectId` 聚合；
- 历史数据：通过 `Project.sourceGroupId` 将旧项目组日志映射到新项目；
- 旧日志不重算、不改写；
- 员工、Key、模型、渠道维度保持现有语义。

## 8. API 设计

### 8.1 项目管理

```text
GET    /api/v1/admin/projects
POST   /api/v1/admin/projects
GET    /api/v1/admin/projects/:id
PATCH  /api/v1/admin/projects/:id
POST   /api/v1/admin/projects/:id/disable
POST   /api/v1/admin/projects/:id/enable
POST   /api/v1/admin/projects/:id/archive
```

### 8.2 项目成员与负责人

```text
GET    /api/v1/admin/projects/:id/members
POST   /api/v1/admin/projects/:id/members
DELETE /api/v1/admin/projects/:id/members/:accountId
POST   /api/v1/admin/projects/:id/members/:accountId/owner
```

### 8.3 项目 Key

```text
GET  /api/v1/admin/projects/:id/api-keys
POST /api/v1/admin/projects/:id/api-keys
POST /api/v1/admin/projects/:id/api-keys/batch-issue
POST /api/v1/admin/api-keys/:id/disable
POST /api/v1/admin/api-keys/:id/enable
POST /api/v1/admin/api-keys/:id/revoke
```

签发对象默认从区域活动成员中选择。

### 8.4 项目预算

```text
GET  /api/v1/admin/projects/:id/budget
POST /api/v1/admin/projects/:id/budget-adjustments
GET  /api/v1/admin/projects/:id/budget-applications
POST /api/v1/admin/projects/:id/budget-applications
POST /api/v1/admin/projects/:id/budget-applications/:applicationId/decision
```

### 8.5 员工视角

```text
GET /api/v1/me/projects
GET /api/v1/me/projects/:id
GET /api/v1/me/projects/:id/usage
GET /api/v1/me/api-keys
```

普通成员可查看自己可选择的项目和自己持有的 Key；项目负责人可查看项目预算与项目用量。

## 9. 管理端信息架构

### 9.1 用量组列表

- 默认只展示 7 个 `REGION` 活动区域；
- 区域行展示项目标签胶囊；
- 支持按区域、项目、负责人、预算风险、Key 覆盖率筛选；
- 点击区域进入区域详情，点击项目标签进入项目详情。

### 9.2 区域详情

- 概览：成员数、项目数、项目预算合计、消耗、预留、可用；
- 成员与负责人；
- 项目列表与项目标签；
- 模型白名单；
- 项目 Key 覆盖率；
- 区域用量趋势。

### 9.3 新增「项目管理」模块

项目列表字段：

- 项目名称 / 编码；
- 所属区域；
- 项目负责人；
- 状态；
- 预算可用与使用率；
- Key 数量；
- 近 7 天用量。

项目详情页：

- 基本信息；
- 项目成员与负责人；
- 项目 Key；
- 预算与申请台账；
- 用量明细；
- 所属区域和模型范围。

## 10. 生产迁移方案

当前生产业务组尚无实际消耗，是迁移最佳窗口。

1. 全量备份；
2. 增加 `REGION`、Project、ProjectMember、ProjectBudget、项目化 Key 和日志字段迁移；
3. 创建 7 个区域组；
4. 将 13 个旧项目组转为 Project，记录 `sourceGroupId`；
5. 旧组当前额度转为项目初始预算；
6. 旧组成员按并集迁入区域组，项目职责写入 ProjectMember；
7. 为现有 23 把项目 Key 生成同项目的新项目 Key，命名改为 `区域-项目-姓名`；
8. 若旧 Key 尚未分发，直接撤销并替换；若已分发，通知员工切换后撤销；
9. 其它区域成员进入“可签发但未签发”状态，由管理员按需或批量签发；
10. 设备授权项目化重签；
11. 旧项目组归档，不删除；
12. 执行区域、项目、预算、Key、网关和管理端验收。

禁止直接修改旧 Key 的 `groupId`：UsageLog 与 Key 存在复合外键关系，历史凭据归属不可变；重新签发符合「历史永不重算」原则。

## 11. 验收标准

### 数据

- 活动业务用量组为 7 个区域组；
- 项目管理模块有 13 个活动项目；
- 13 个旧项目组归档且保留历史关联；
- 项目预算合计仍为 ¥13,650；
- 46 条人员-区域归属全部完成；
- 108 个“人员 × 区域内项目”组合默认具备 Key 签发资格；
- 现有 23 个实际使用需求替换为项目 Key，其余 85 个组合可在管理端批量签发。

### 网关

- 使用项目 Key 请求，日志记录正确区域和项目；
- 项目 Key 未配置、禁用、撤销时拒绝；
- 所有可计费请求都有项目归属，不存在区域未分配消耗；
- 项目预算耗尽返回 `429 project_budget_exceeded`；
- 请求和响应正文仍不落盘。

### 管理端

- 用量组列表按 7 个区域展示；
- 区域行展示项目标签；
- 项目管理页可维护项目、负责人、Key 和预算；
- 项目 Key 签发不要求 AI CLI 配置额外请求头；
- 统计分析支持区域汇总与项目下钻；
- 历史数据仍可按旧项目组映射查看。

## 12. 实施分期

### 一期 / 0.8.0

- 7 个区域组；
- 项目档案与项目职责成员；
- 项目预算池；
- 项目化员工 API Key；
- 用量组区域展示与项目标签；
- 区域/项目统计；
- 现有 23 把 Key 替换。

### 二期 / 0.8.x

- 项目预算申请审批流；
- 项目负责人门户；
- 批量 Key 签发与覆盖率提醒；
- 项目化设备授权体验优化；
- 更细的项目成本报表和告警策略。