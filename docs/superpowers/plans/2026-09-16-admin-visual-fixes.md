# 管理端视觉缺陷修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复浏览器验收确认的深色控件遗漏、窄屏表格挤压和趋势图重叠，不改变成本与权限逻辑。

**Architecture:** 沿用 Vue 页面、共享 CSS 和 TrendChart；在公共样式层补齐默认控件，在布局定义处消除覆盖，在共享图表组件中固定图例区域。表格保留现有列和横向滚动，不另建移动端组件。

**Tech Stack:** Vue 3、TypeScript、原生 CSS、ECharts、Vitest、Vue Test Utils；浏览器视觉验证使用现有浏览器工具。

**Spec:** 本计划“验收依据与范围”记录 2026-09-16 浏览器质检结果及用户确认的修复范围；无需新增设计系统或架构规范。

## Global Constraints

- 仅前端样式、必要的布局标记及回归测试；不修改 API、数据库、人民币金额精度、缓存计费、预算规则或权限。
- 不新增依赖、组件库、主题系统或浏览器测试框架。
- 生产环境仅查看；创建、保存、预算调整等提交测试在本地测试数据上进行。
- 登录中断单独记录，不推断为权限故障，不延长会话或放松认证。
- 本轮只制定计划。执行须另获确认；发布须另行批准，不能把执行批准视作发布批准。
- 实施前检查工作区状态，从当前发布基线建立 `codex/admin-visual-fixes` 隔离分支，保留已有用户文件。

## 验收依据与范围

已实际检查：服务总览、统计分析、用量组列表、创建抽屉和组详情。浏览器读到视口宽度 837px；此轮尚未完成其他管理页面的完整验收。

| 缺陷 | 证据与原因 | 优先级 |
| --- | --- | --- |
| 原生白色按钮、默认蓝色链接 | 总览刷新按钮、分析清空按钮、组查询和抽屉按钮缺少公共默认主题；蓝色链接在深色背景难辨 | P1 |
| 白色说明文本框 | 创建及详情 textarea 实际背景 rgb(255,255,255)；全局表单规则只覆盖 input/select | P1 |
| 窄屏挤压 | 组名、成员信息接近逐字竖排，预算进度溢出可视区；表格未限制合理最小列宽 | P1 |
| 小屏布局覆盖 | main.ts 后加载 procurement-costs-responsive.css，其中顶层 .shell 双栏规则覆盖先前 <=900px 的单栏规则 | P1 |
| 图例与日期重叠 | 总览及统计分析实际截图确认；TrendChart 未显式限定图例位置，需要在本地复现后验证固定区域方案 | P1 |

## 文件职责

- `apps/admin/src/styles.css`：基础主题、链接、布局断点、焦点与禁用状态；全站 shell 唯一归属。
- `apps/admin/src/forms.css`：textarea 与现有表单控件统一，表单操作区对齐。
- `apps/admin/src/analytics.css`：分析表格最小宽度和图表容器；移除重复 shell 规则。
- `apps/admin/src/procurement-costs-responsive.css`：只保留采购成本自身响应式规则，移除全站 shell 覆盖。
- `apps/admin/src/views/UsageGroups.vue`：列表专属样式钩子及创建按钮主次标记。
- `apps/admin/src/components/UsageFilters.vue`：应用/清空按钮保持同组，不改筛选事件。
- `apps/admin/src/components/TrendChart.vue`：所有调用方共享的图例、网格和轴标签位置。
- `test/admin/analytics-operations.test.ts`：图表配置回归；已有其他管理端测试保持通过。
- `docs/verification/2026-09-16-admin-visual-fixes.md`：实施时创建，保存实际检查结果与未覆盖项。

## Task 1：补齐公共控件主题

**Interfaces:** 不改变组件 props、事件、API；现有 `.primary`、`.danger-button`、`.icon-button` 和特殊时间轴按钮继续覆盖低优先级默认规则。

- [ ] **先记录失败基线。** 本地复现总览按钮、分析清空按钮、组创建/详情 textarea 的白色样式；打开抽屉后取消。以截图为视觉失败证据，不能用 happy-dom 冒充真实布局验证。
- [ ] **在 styles.css 添加低优先级基础规则。** 沿用项目已有颜色；不要给所有按钮统一固定高度，避免影响时间轴和图标按钮。

```css
:where(button) {
  border: 1px solid #223046; background: #0d1724; color: #aebbd0;
  border-radius: 8px; padding: 9px 14px; font: inherit; cursor: pointer;
}
:where(button:disabled) { opacity: .5; cursor: not-allowed; }
:where(a) { color: #76e6c8; text-underline-offset: 3px; }
:where(button, a, input, select, textarea):focus-visible {
  outline: 2px solid #76e6c8; outline-offset: 2px;
}
```

- [ ] **把 forms.css 的 input/select 主题及 focus 规则扩展到 textarea。** 不重复复制规则；补充以下约束，并让日期控件匹配深色背景。

```css
textarea { min-height: 96px; resize: vertical; font-family: inherit; }
input[type="date"], select { color-scheme: dark; }
.usage-filter-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
```

- [ ] **UsageFilters.vue 将已有应用、清空按钮包在 `.usage-filter-actions` 中。** 保留两个按钮的事件、type 和 loading 条件。UsageGroups.vue 创建按钮添加 `class="primary"`，取消保持次按钮，保留原来的 pending/必填条件。
- [ ] **验证。** 逐个用 Tab 导航检查焦点；默认、悬停、禁用、错误状态可区分。特别回归采购时间轴、危险操作按钮和图标关闭按钮，确认公共规则没有覆盖专属样式。
- [ ] **运行已有测试并检查 diff。** `npx vitest run test/admin/usage-filters.test.ts test/admin/usage-group-operations.test.ts test/admin/dialog-focus.test.ts --maxWorkers=1`。检查通过后独立提交本任务。

## Task 2：修复响应式覆盖和表格挤压

**Interfaces:** 表格列、排序、分页和筛选参数保持不变；只有表格区域允许横向滚动，页面主体不得横向溢出。

- [ ] **先复现失败。** 在 837×856 和 1440×900 视口分别检查列表；记录组名逐字换行、小屏仍保留 238px 侧栏及进度条截断。
- [ ] **统一 shell 归属。** styles.css 默认改为 `238px minmax(0,1fr)`，保留 <=900px 单栏断点；删除 analytics.css、procurement-costs-responsive.css 内重复的 `.shell` 规则。保留 `.content` 的 min-width 约束。
- [ ] **小屏沿用现有单栏设计。** 仅将原导航改为多列紧凑排列，不增加抽屉菜单状态或图标库：

```css
@media (max-width: 900px) {
  .shell > aside nav { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
  .shell > aside .logout { margin-top: 8px; }
}
```

- [ ] **UsageGroups.vue 的 table 添加 `.usage-groups-table`。** 在现有共享样式文件加入定向宽度；不对全站所有 td 强制 nowrap，也不隐藏成本列。

```css
.usage-groups-table { min-width: 1000px; }
.usage-groups-table th { white-space: nowrap; }
.usage-groups-table td:first-child { min-width: 150px; }
.usage-groups-table td:nth-child(3) { min-width: 150px; }
.usage-groups-table td:nth-child(5),
.usage-groups-table td:nth-child(6) { min-width: 160px; }
.usage-groups-table progress { width: 120px; max-width: 100%; accent-color: #52d6b3; }
.breakdown-panel table { min-width: 900px; }
.breakdown-panel th { white-space: nowrap; }
```

- [ ] **浏览器验证。** 在 1440、1024、837、390px 宽度逐项检查：主体无横向滚动；表格可以横向滚到最后一列；组名与成员信息可读；长名称允许合理换行；主次按钮不遮挡；抽屉关闭和提交按钮始终可到达。不要仅依赖全页截图判断滚动可用。
- [ ] **执行回归。** `npx vitest run test/admin/usage-group-operations.test.ts test/admin/procurement-costs.test.ts test/admin/analytics-operations.test.ts --maxWorkers=1`。同时浏览采购成本页验证原树形列表及时间轴滚动。通过后独立提交。

## Task 3：修复共享趋势图并完成验收

**Interfaces:** 保持 `TrendChart` 的 data/metric/timezone、人民币值、成功率右轴及 null 缺口语义；覆盖 Dashboard、Analytics、UsageGroupDetail 三个调用方。

- [ ] **在现有 analytics-operations.test.ts 的图表测试中添加失败断言。** 使用已有 `option()` 和 ECharts mock，不新建图表配置抽象。

```ts
expect(option().legend).toMatchObject({ top: 8, left: 'center' })
expect(option().grid).toMatchObject({ top: 56, bottom: 48, containLabel: true })
expect(option().xAxis.axisLabel).toMatchObject({ hideOverlap: true })
```

- [ ] **运行失败测试。** `npx vitest run test/admin/analytics-operations.test.ts --maxWorkers=1`；确认失败来自新增布局断言，而非环境问题。
- [ ] **显式设置图例和网格。** 保留现有轴数据和 formatter，只替换对应配置字段：

```ts
legend: { top: 8, left: 'center', textStyle: { color: '#8fa1b8' } },
grid: { left: 52, right: 52, top: 56, bottom: 48, containLabel: true },
// 在现有 xAxis.axisLabel 中增加，不替换日期数据：
axisLabel: { color: '#728199', hideOverlap: true },
```

- [ ] **再运行测试并实际查看图表。** 分别验证空数据、单个数据点、7/30/90 天、三种 metric、窗口缩放；图例与日期不重叠，左右轴不裁切，空状态正常。仅有配置断言通过不足以宣布视觉修复完成。
- [ ] **整体回归。** 顺序运行 `npx vitest run test/admin --maxWorkers=1`、`npm run typecheck`、`npm run admin:build`，每一步保存真实结果；若需生成 Prisma 客户端，先执行项目现有 `npm run db:generate`，不改依赖。
- [ ] **浏览器最终验收。** 重点页：总览、统计分析、用量组列表/详情/创建抽屉；抽查公共样式消费者：使用日志、渠道、模型、采购成本、模型测试。只查看模型测试表单，不触发付费请求。确认筛选、分页、切换页签、抽屉取消关闭正常。
- [ ] **归档证据。** 创建 verification 文档，写明实际分辨率、检查页面、截图对比、测试结果及未覆盖项。若再次跳登录页，只记录时间与页面，另行定位认证原因。
- [ ] **交付和发布分开。** 整理独立提交供审核；提供已修复项与遗留项，等待用户决定是否合并和发布。不自动改版本号、生产配置或部署。

## 完成标准

- 以上五类已确认问题在宽屏和 837px 侧栏宽度均不再出现，390px 下所有内容和操作可通过正常滚动访问。
- 金额、请求数、预算进度数值和筛选语义不变；没有以隐藏列、缩小文字到不可读或截断金额规避布局问题。
- 控件主题一致，键盘焦点可见；既有前端测试与构建通过，浏览器验证单独记录。
- 登录中断未复现或未定位时明确标注，不混入“已修复”清单。
