# 采购成本配置工作台优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将分散、拥挤的采购成本抽屉升级为独立工作台，让管理员能够快速查看各渠道模型当前生效成本、配置基础价和高峰分时价，并在保存前验证冲突、兜底来源及预计采购成本。

**Architecture:** 保留现有“公共模型价格兜底 + 渠道模型成本规则覆盖”的运行时语义与历史成本快照，新建面向管理操作的聚合查询和成本试算接口。管理端采用“筛选与对象列表 + 当前状态摘要 + 周时间轴 + 单规则编辑面板”的主从布局；原渠道详情和模型详情仅保留摘要与深链入口。第一阶段不修改数据库结构，时间轴和规则状态通过现有规则、时区及公共价格即时计算。

**Tech Stack:** Vue 3, Vue Router, TypeScript, NestJS, Prisma, PostgreSQL, Decimal.js, Vitest.

**Execution status (2026-08-24):** Tasks 1–7 已完成。仓库没有既有 Playwright E2E 基础设施，因此 Task 7 使用本地 API、管理端和应用内浏览器完成真实流程验收；自动化回归由 56 个 Vitest 测试文件（308 项测试）及 `npm run verify` 发布门禁覆盖。

## Global Constraints

- 本平台只管理公司统一采购并分配给员工使用的内部成本，不增加用户销售价格、收入或利润字段。
- 币种固定为 `CNY`，页面统一显示为 `¥ / 1M Token`。
- 公共模型价格是无渠道规则命中时的兜底；渠道基础规则和分时覆盖规则的来源必须明确可见。
- 保留已有用量记录的成本快照及归档数据，不追溯重算历史成本。
- 渠道成本时区沿用渠道的 IANA `costTimezone`；所有日期、工作日和跨午夜解释均以该时区为准。
- 同优先级且生效日期重叠的时间规则继续禁止保存；不同语义层级按优先级解析。
- 第一阶段不做 CSV 导入导出，不新增销售定价，不把采购成本编辑能力塞回现有 880px 抽屉。

## Product Interaction Specification

### Information architecture

- 左侧导航新增“采购成本”，路由为 `/procurement-costs`。
- 渠道详情中的“采购成本”和模型详情中的“渠道实际采购价格”改为摘要卡片，并提供“进入成本工作台”深链，携带 `channelId`、`channelModelId` 或 `publicModelId` 查询参数。
- 工作台默认按“厂家 → 公共模型 → 渠道模型”组织，可按厂家、模型、渠道和配置状态筛选。
- 配置状态至少包括：`渠道规则生效中`、`部分时段使用公共兜底`、`仅使用公共兜底`、`无可用成本`、`即将生效`、`已停用`。

### Page layout

```text
┌ 采购成本工作台 ──────────────────────────────────────────────┐
│ 厂家 [全部]  模型 [全部]  渠道 [全部]  状态 [全部]  搜索 [...] │
├──────────────────┬──────────────────────────────────────────┤
│ DeepSeek          │ 当前生效  ¥3 / ¥6    来源：工作日基础价   │
│  DeepSeek Chat    │ 下次切换  今天 18:00 → 晚高峰价           │
│   ● 官方渠道       │ 覆盖状态  35h 渠道规则 / 133h 公共兜底    │
│   ○ 备用渠道       ├──────────────────────────────────────────┤
│  DeepSeek Reasoner│ 周时间轴：基础价 / 高峰价 / 公共兜底       │
│                  │ 周一 [────基础────][高峰][──兜底──]       │
│                  │ ...                                      │
│                  ├──────────────────────────────────────────┤
│                  │ 规则列表                         + 新建规则 │
└──────────────────┴──────────────────────────────────────────┘
                                              [右侧单规则编辑栏]
```

### Cost semantics shown to operators

1. **公共兜底价**：在模型目录维护，所有渠道都没有命中自身规则时使用。
2. **渠道基础价**：通常全天、每天生效，语义优先级默认 `0`。
3. **分时覆盖价**：工作日高峰、晚高峰或周末价，语义优先级默认 `10`。
4. **高级优先级**：默认收起，仅允许有明确需求的管理员调整原始优先级。
5. 同一时刻的展示必须包含“最终价格、命中规则、来源、时区、下次切换时间”，避免只显示一组无法解释的金额。

### Rule editor

- 第一段“规则用途”：规则名称、类型（全天基础价/工作日高峰/每日晚高峰/周末价/自定义），模板只填默认值，用户仍可修改。
- 第二段“时间范围”：工作日、多选日期、全天开关、起止时间、跨午夜自然语言提示、渠道时区只读提示。
- 第三段“采购单价”：输入与输出价格默认展开；缓存与推理价格放在“可选价格项”折叠区；单位始终显示 `CNY / 1M Token`。
- 第四段“生效周期”：立即生效或指定开始时间，可选结束时间，显示本地时区解释。
- 第五段“保存前预览”：展示冲突、被覆盖时段、使用公共兜底的空档、所选时间点最终规则以及样例 Token 成本。
- 操作包含保存、保存并新建、复制、停用、归档；归档入口使用二次确认，已归档规则在独立页签中恢复。

### Rule list and timeline

- 规则列表列出：状态、类型/名称、星期与时段、输入/输出价、可选价摘要、生效周期、更新时间、操作。
- 状态区分 `当前生效`、`未来生效`、`已过期`、`已停用`、`已归档`，不再只依赖启用开关。
- 周时间轴第一阶段采用 30 分钟视觉粒度，但保留分钟级表单与运行时解析；鼠标悬停/点击显示精确起止分钟。
- 时间轴颜色固定：公共兜底为灰色、渠道基础价为绿色、分时覆盖为橙色、无成本为红色、当前所选时刻加描边。
- 时间轴上方提供“时间点试算”：日期时间、输入 Token、输出 Token、缓存 Token、推理 Token；结果展示预计采购成本和计算明细。

## Acceptance Criteria

- 管理员不进入编辑态即可看到当前生效价格、来源、时区及下次切换时间。
- 从渠道详情或模型详情进入工作台时，目标渠道模型已自动选中。
- 新建“全天基础价 + 工作日晚高峰价”不超过 3 个主要操作阶段，并可在同一页面确认时间轴结果。
- 同优先级冲突在保存前明确标出冲突规则和冲突时段，服务端仍进行最终校验。
- 未被渠道规则覆盖的时间段明确显示为公共模型兜底；公共价格也不存在时显示红色阻断状态。
- 输入任意时间和 Token 数量后，页面展示与网关运行时一致的命中规则和人民币成本。
- 跨午夜、有效期边界、夏令时区、规则停用和公共兜底均有自动化测试。
- 1440px 桌面宽度完整展示主从工作台；1024px 时对象列表可折叠、编辑栏覆盖显示且不丢失上下文。

---

### Task 1: 成本时间轴与试算领域能力

**Files:**
- Modify: `packages/gateway-core/src/cost-schedule.ts`
- Modify: `packages/gateway-core/src/cost.ts`
- Test: `test/gateway/cost-schedule.test.ts`

**Interfaces:**
- Add: `resolveChannelCostWithFallback(rules, fallback, at, timezone)`，统一返回渠道规则或公共兜底来源。
- Add: `nextCostTransition(rules, fallback, at, timezone)`，返回下一次最终价格/来源发生变化的时间。
- Add: `estimateProcurementCost(price, tokens)`，使用 Decimal 计算输入、输出、缓存和推理成本明细。
- Preserve: `resolveChannelCost` 的现有行为，避免改变网关调用方。

- [ ] **Step 1: 编写失败测试**，覆盖渠道规则命中、公共兜底、无成本、跨午夜、有效期边界、不同优先级、下一切换点和四类 Token 的 CNY 试算。
- [ ] **Step 2: 运行** `npm test -- test/gateway/cost-schedule.test.ts`，确认新增断言因接口不存在而失败。
- [ ] **Step 3: 实现纯函数**，复用现有 `localTime`、`matchesLocalTime` 和 Decimal 价格计算，不访问数据库。
- [ ] **Step 4: 重跑测试**，确认既有解析测试和新增测试全部通过。
- [ ] **Step 5: Commit**：`git add packages/gateway-core/src/cost-schedule.ts packages/gateway-core/src/cost.ts test/gateway/cost-schedule.test.ts && git commit -m "feat: add procurement cost evaluation primitives"`

### Task 2: 采购成本工作台聚合与试算 API

**Files:**
- Create: `apps/api/src/procurement-costs.controller.ts`
- Create: `apps/api/src/procurement-costs.service.ts`
- Modify: `apps/api/src/catalog.dto.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `test/catalog/procurement-costs.controller.test.ts`
- Test: `test/catalog/procurement-costs.service.test.ts`

**Interfaces:**
- Add: `GET /api/v1/admin/procurement-costs?manufacturer=&publicModelId=&channelId=&status=&search=&limit=&offset=`。
- Response item includes: manufacturer/public model/channel/channel model identity, timezone, current effective cost, fallback price, active/future/disabled rule counts, coverage summary and next transition.
- Add: `POST /api/v1/admin/channel-models/:id/cost-evaluation` with `{ at, inputTokens, outputTokens, cachedTokens?, reasoningTokens? }`。
- Evaluation response includes: matched source/rule, four unit prices, four cost subtotals, total CNY, timezone and next transition.

- [ ] **Step 1: 编写 controller 失败测试**，验证路由、查询 DTO、UUID/日期/非负 Token 校验及平台管理员权限。
- [ ] **Step 2: 编写 service 失败测试**，构造“渠道覆盖、部分兜底、仅兜底、无成本、即将生效”五类数据，断言聚合状态与试算结果。
- [ ] **Step 3: 运行** `npm test -- test/catalog/procurement-costs.controller.test.ts test/catalog/procurement-costs.service.test.ts` 并确认失败原因符合预期。
- [ ] **Step 4: 实现 DTO、查询与评估服务**；数据库查询一次批量加载渠道模型、规则和公共模型当前价格，避免逐行 N+1。
- [ ] **Step 5: 在 `AppModule` 注册 controller/service**，重跑两项测试并运行 `npm run typecheck`。
- [ ] **Step 6: Commit**：`git add apps/api/src/procurement-costs.controller.ts apps/api/src/procurement-costs.service.ts apps/api/src/catalog.dto.ts apps/api/src/app.module.ts test/catalog/procurement-costs.controller.test.ts test/catalog/procurement-costs.service.test.ts && git commit -m "feat: expose procurement cost workspace api"`

### Task 3: 管理端状态模型、路由与工作台骨架

**Files:**
- Create: `apps/admin/src/procurement-costs.ts`
- Create: `apps/admin/src/views/ProcurementCosts.vue`
- Modify: `apps/admin/src/types/catalog.ts`
- Modify: `apps/admin/src/main.ts`
- Modify: `apps/admin/src/App.vue`
- Create: `test/admin/procurement-costs.test.ts`

**Interfaces:**
- Add: `ProcurementCostWorkspaceItem`, `CostConfigurationStatus`, `CostEvaluation` UI contracts.
- Add pure helpers for status labels, rule lifecycle labels, deep-link query parsing and CNY display.
- Route: `/procurement-costs`, name `procurement-costs`，导航文案“采购成本”。

- [ ] **Step 1: 编写失败测试**，断言六类配置状态、当前/未来/过期/停用生命周期标签、深链选择和人民币格式。
- [ ] **Step 2: 运行** `npm test -- test/admin/procurement-costs.test.ts`，确认帮助函数尚未实现。
- [ ] **Step 3: 实现纯帮助函数与类型**，避免把业务判断散落到 Vue 模板。
- [ ] **Step 4: 创建工作台骨架**，完成筛选栏、对象树、摘要卡、空态/错误态/加载态以及 URL 查询参数同步。
- [ ] **Step 5: 增加路由与侧边导航**，重跑测试和 `npm run admin:build`。
- [ ] **Step 6: Commit**：`git add apps/admin/src/procurement-costs.ts apps/admin/src/views/ProcurementCosts.vue apps/admin/src/types/catalog.ts apps/admin/src/main.ts apps/admin/src/App.vue test/admin/procurement-costs.test.ts && git commit -m "feat: add procurement cost workspace shell"`

### Task 4: 周时间轴与时间点试算组件

**Files:**
- Create: `apps/admin/src/components/CostTimeline.vue`
- Create: `apps/admin/src/components/CostEvaluationPanel.vue`
- Create: `apps/admin/src/procurement-costs.css`
- Modify: `apps/admin/src/main.ts`
- Modify: `apps/admin/src/views/ProcurementCosts.vue`
- Modify: `test/admin/procurement-costs.test.ts`

**Interfaces:**
- `CostTimeline` consumes active rules, fallback price, timezone and selected timestamp; emits selected timestamp/rule.
- `CostEvaluationPanel` consumes selected channel model and calls the evaluation endpoint with Token inputs.

- [ ] **Step 1: 增加失败测试**，覆盖 30 分钟块映射、跨午夜分段、优先级覆盖、公共兜底、无成本及当前选择标记。
- [ ] **Step 2: 运行** `npm test -- test/admin/procurement-costs.test.ts` 并确认时间轴断言失败。
- [ ] **Step 3: 实现时间轴视图模型和组件**，保持分钟级 tooltip，不把 30 分钟展示粒度用于运行时计算。
- [ ] **Step 4: 实现时间点与 Token 试算面板**，处理请求竞态、错误态、零 Token 和千分位格式。
- [ ] **Step 5: 接入工作台并补充桌面/1024px 样式**，运行测试及 `npm run admin:build`。
- [ ] **Step 6: Commit**：`git add apps/admin/src/components/CostTimeline.vue apps/admin/src/components/CostEvaluationPanel.vue apps/admin/src/procurement-costs.css apps/admin/src/main.ts apps/admin/src/views/ProcurementCosts.vue test/admin/procurement-costs.test.ts && git commit -m "feat: visualize and evaluate procurement schedules"`

### Task 5: 结构化规则编辑器与保存前预览

**Files:**
- Create: `apps/admin/src/components/CostRuleForm.vue`
- Modify: `apps/admin/src/components/CostScheduleEditor.vue`
- Modify: `apps/admin/src/views/ProcurementCosts.vue`
- Modify: `apps/admin/src/procurement-costs.ts`
- Modify: `apps/admin/src/procurement-costs.css`
- Modify: `test/admin/procurement-costs.test.ts`
- Modify: `test/catalog/channel-models.service.test.ts`

**Interfaces:**
- `CostRuleForm` supports create/edit/duplicate and emits existing `CreateCostRuleDto`/`UpdateCostRuleDto` compatible payloads.
- Quick templates: 全天基础价、工作日高峰、每日晚高峰、周末价、自定义。
- Existing preview endpoint remains the final server-side conflict validator.

- [ ] **Step 1: 增加失败测试**，断言模板默认日/时段/优先级、全天与跨午夜转换、可选价格默认值、日期序列化和编辑回填。
- [ ] **Step 2: 增加 service 回归测试**，确认同优先级冲突仍被拒绝、不同优先级覆盖允许保存、归档规则不参与冲突。
- [ ] **Step 3: 运行** `npm test -- test/admin/procurement-costs.test.ts test/catalog/channel-models.service.test.ts`，确认新增场景失败。
- [ ] **Step 4: 实现五段式规则表单**，把原 `CostScheduleEditor` 中的表单逻辑迁移到新组件；原组件暂保留兼容包装，避免一次性破坏详情页。
- [ ] **Step 5: 在工作台实现新建、编辑、复制、启停、归档、恢复和保存后刷新选中对象；保存前同时展示服务端冲突与客户端时间轴影响。
- [ ] **Step 6: 重跑目标测试、`npm run typecheck` 和 `npm run admin:build`。**
- [ ] **Step 7: Commit**：`git add apps/admin/src/components/CostRuleForm.vue apps/admin/src/components/CostScheduleEditor.vue apps/admin/src/views/ProcurementCosts.vue apps/admin/src/procurement-costs.ts apps/admin/src/procurement-costs.css test/admin/procurement-costs.test.ts test/catalog/channel-models.service.test.ts && git commit -m "feat: streamline procurement cost rule editing"`

### Task 6: 渠道、模型详情深链与语义收口

**Files:**
- Modify: `apps/admin/src/views/ChannelDetail.vue`
- Modify: `apps/admin/src/views/ModelDetail.vue`
- Modify: `apps/admin/src/model-cost-alignment.ts`
- Modify: `test/admin/model-cost-alignment.test.ts`
- Modify: `test/admin/procurement-costs.test.ts`

**Interfaces:**
- Channel deep link: `/procurement-costs?channelId=<id>&channelModelId=<id>`。
- Model deep link: `/procurement-costs?publicModelId=<id>`。
- Detail pages show only current price/source, timezone, next transition and configuration status; complete editing occurs in workspace.

- [ ] **Step 1: 编写失败测试**，验证详情页摘要文案、公共兜底标识和深链参数。
- [ ] **Step 2: 运行** `npm test -- test/admin/model-cost-alignment.test.ts test/admin/procurement-costs.test.ts` 并确认失败。
- [ ] **Step 3: 将渠道详情的 880px 成本抽屉替换为摘要 + 深链**；保留模型绑定、测试等无关操作。
- [ ] **Step 4: 将模型详情的渠道成本表和公共兜底区统一术语**，公共价格仍在模型级维护，渠道分时规则跳转到工作台。
- [ ] **Step 5: 重跑测试与 `npm run admin:build`。**
- [ ] **Step 6: Commit**：`git add apps/admin/src/views/ChannelDetail.vue apps/admin/src/views/ModelDetail.vue apps/admin/src/model-cost-alignment.ts test/admin/model-cost-alignment.test.ts test/admin/procurement-costs.test.ts && git commit -m "refactor: centralize procurement cost management"`

### Task 7: 端到端验收与发布闭环

**Files:**
- Create: `test/e2e/procurement-cost-workspace.spec.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Test fixtures:**
- 一个有公共兜底价格的公共模型。
- 一个全天渠道基础规则。
- 一个工作日 18:00–23:00 的高峰覆盖规则。
- 一个跨午夜规则。
- 一个没有公共兜底也没有渠道规则的模型。

- [ ] **Step 1: 编写 E2E 场景**：从渠道详情深链进入、创建高峰规则、预览时间轴、试算高峰/低峰成本、触发冲突、停用规则后回落公共兜底、归档并恢复。
- [ ] **Step 2: 启动本地 API/管理端和依赖服务**，执行 E2E 并保存失败证据。
- [ ] **Step 3: 修复仅由 E2E 暴露的交互/可访问性问题**，不扩大业务范围。
- [ ] **Step 4: 运行** `npm run verify`，确认类型检查、覆盖率、后端构建、管理端构建和许可证检查全部通过。
- [ ] **Step 5: 在 1440px 与 1024px 视口完成视觉检查**，重点确认时间轴、右侧编辑栏、错误提示和归档确认。
- [ ] **Step 6: 更新 README/CHANGELOG**，记录采购成本语义、CNY 单位、时区规则和工作台入口。
- [ ] **Step 7: Commit**：`git add test/e2e/procurement-cost-workspace.spec.ts README.md CHANGELOG.md && git commit -m "test: verify procurement cost workspace flows"`

## Delivery Phases

### Phase 1 — 可用性闭环（Tasks 1–7）

- 独立工作台、当前价格与来源、周时间轴、结构化编辑、冲突/兜底预览、时间点试算、详情页深链。
- 不要求数据库迁移，可沿用现有成本规则和公共模型价格表。

### Phase 2 — 批量维护与审计（后续独立评审）

- 将一组规则复制到多个渠道模型，并在事务内逐目标校验冲突。
- 展示最后修改人、修改时间及版本差异；该能力可能需要成本规则审计视图或数据库字段。
- 成本变更影响分析：按近 7/30 天实际 Token 结构估算新旧规则的成本差异，但不修改历史统计。

## Rollback Strategy

- 新工作台使用独立路由和 API；发生问题时可从导航隐藏入口，并让详情页暂时恢复旧 `CostScheduleEditor` 包装。
- 所有规则写操作继续调用既有 CRUD 服务，回滚 UI 不会丢失或转换现有数据。
- 新聚合和试算 API 为只读计算，不参与网关请求路径；移除 controller/service 不影响模型调用。
- 不做数据库迁移，因此第一阶段回滚不需要执行反向 migration。
