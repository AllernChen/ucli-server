# 管理端成本运营验收记录

验收日期：2026-09-16（Asia/Shanghai）。计划日期为 2026-09-15。
工作分支：`codex/admin-cost-operations`；基线：`3d34bf5`。验收代码为本记录所在提交。

## 范围与环境

仅在本地专用 PostgreSQL 16.11 测试库、专用 Redis 和合成数据上执行。API/Gateway 使用真实应用模块、认证守卫、DTO 校验及响应拦截器，绑定 `127.0.0.1`；管理端使用本地 Vite。没有连接生产环境、调用付费上游、部署、推送或合并。

新增页面、侧栏入口及服务状态检查均只在本地验收，尚未发布到线上。

浏览器复用平台管理员、组织管理员、员工三个专用账号。新增合成数据包括可辨识的核算组、历史待核算组、5,001 个 CSV 边界请求及模型、5,001 条路由、200 个预算风险组和外组织隔离样本。所有新渠道均禁用，上游地址为无服务的本地端口。脚本、凭据与连接配置保存在忽略的本地验收目录，不纳入版本控制。

## 修复与回归证据

| 问题 | RED | 修复后行为 |
| --- | --- | --- |
| 使用日志 URL 的 `limit=200&offset=200` 被初始页大小覆盖 | 00:53，组件实际渲染 50 行，预期 200 行 | 路由恢复页大小；首次打开、上一页历史、重新挂载均保持 200 行；默认 50、边界 1 仍有效 |
| 缓存覆盖分子按路由、分母按完整请求计算 | 00:53，真实 PG 返回 300/50，预期 300/350 | 分母取相同匹配路由调用的输入量；保留可靠重试用量，不截断或钳制百分比；兼容请求级 token 和费用字段保持原值 |
| 大量维度分组时价格关联产生平方级比较 | 01:08，101 个含空值的渠道组产生 10,100 次无效配对；01:10 最终测试对旧实现再次复现 | 使用两列等值条件保留空值与空字符串区别，允许 PostgreSQL 哈希连接；真实 5,001 模型查询由 12.9 秒降到 430 毫秒 |

性能回归测试在独立事务中临时关闭 nested-loop 偏好，以验证该连接可使用线性连接算法，不受小数据集估计影响；事务结束即恢复。实际 90 天 EXPLAIN 使用默认规划器设置。没有新增索引、迁移、缓存或依赖。

## 命令与结果

命令在工作树根目录执行；运行前设置专用本地 `DATABASE_URL`、`TEST_DATABASE_URL`、`TEST_REDIS_URL`，本记录不保存连接串。

| 时间（9 月 16 日） | 命令 / 检查 | 结果 |
| --- | --- | --- |
| 00:53 | `npx vitest run test/admin/usage-paging.test.ts test/integration/usage-operations.test.ts` | 预期 RED，exit 1：2 failed / 11 passed；两个故障均实际复现 |
| 00:54 | 上述测试加 `test/analytics/analytics.service.test.ts test/admin/group-usage.test.ts` | exit 0：24 passed / 0 skipped |
| 01:04 | `npx vitest run test/integration/usage-operations.test.ts test/integration/group-budget-read.test.ts test/integration/group-cost-reconciliation.test.ts` | exit 0：15 passed / 0 skipped，真实 PG |
| 01:06 | `npm run verify`（性能修复前） | exit 0：124 文件 / 792 测试，无跳过；typecheck、coverage、服务端 build、admin build、licenses 全过 |
| 01:08、01:10 | `npx vitest run test/integration/usage-operations.test.ts -t 'joins many price groups'` | 预期 RED，exit 1：1 failed；12 个未选中测试明确跳过 |
| 01:09 | `npx vitest run test/integration/usage-operations.test.ts` | exit 0：13 passed / 0 skipped |
| 01:11 | 三个指定 PG 文件加 `test/admin/usage-paging.test.ts` | exit 0：17 passed / 0 skipped；随后服务端 build exit 0 |
| 01:12（测试于 01:12:36 开始） | 最终 `npm run verify`（含性能修复） | exit 0：124 文件 / 793 测试，0 skipped；测试用时 68.74 秒；typecheck、服务端 build、admin build、licenses 全部通过 |
| 01:12 后 | `node .superpowers/sdd/2026-09-15-admin-cost-operations/task-9-http.mjs` | exit 0：最终服务的 32 个真实 HTTP 响应通过 |
| 01:05、01:09 | `node .superpowers/sdd/2026-09-15-admin-cost-operations/task-9-explain.mjs` | exit 0：修复前后各完成 3 个参数化 EXPLAIN，结果见下表 |

最终 coverage：statements / lines 96.07%，branches 87.71%，functions 97.82%。Admin build 转换 708 个模块，8.52 秒完成；license gate 通过 452 个 package records。最终 Prisma 配置测试 2/2 通过（1,941 ms，其中真实 ESM 加载 1,825 ms）。01:16 汇总时已确认整个 verify 命令 exit 0。

主控随后对相同最终代码独立执行 `npm run verify`，exit 0：测试于 01:18:49 开始，124 文件 / 793 passed / 0 skipped，62.83 秒；coverage statements / lines 96.07%、branches 87.74%、functions 97.82%；typecheck、服务端 build、admin build（708 模块，主包 888.19 kB）及 452 条依赖许可证检查全部通过。

完整回归中的故障注入会输出 `group-settlement-pending`、`group-quota-recovery-pending`、`gateway-route-failed`；这些来自通过的故障处理测试。管理端构建有既有大于 500 kB 的 chunk 提示，未新增依赖或拆包。Prisma ESM 冷启动测试使用已提交的局部超时修复，本次没有修改超时或排除测试。

## 真实 HTTP 与金额对账

本地脚本通过登录接口获取临时 token，仅存在进程内；使用真实 HTTP 请求，不以方法调用或装饰器元数据代替下载验证。首次验收共 32 个响应全部符合预期；01:12 最终服务重启后再次执行，仍为 32 个响应全部通过、exit 0。

- 两种 CSV 均在 5,000 行返回 HTTP 200，核对 `Content-Type: text/csv; charset=utf-8`、attachment 文件名、`Cache-Control: no-store`、UTF-8 BOM、中文、完整行数；使用 `limit=1&offset=4999` 仍导出所有匹配行。
- 两种 CSV 在 5,001 行均返回 HTTP 400 和明确的 5,000 行限制错误，没有静默截断；匿名请求 HTTP 401，没有数据泄露。
- 核算组：3 请求、请求成功率 100%、完整成本 `3.90000000`；缓存覆盖 300/360、未知调用 2。上海午夜前两请求 `1.90000000`，午夜后一请求 `2.00000000`。
- 同一历史价格筛选：overview、跨页日志 `matchedCostCny` 合计、两类 CSV 的匹配成本列一致。独立 PG 回归使用 Decimal，匹配成本 `0.60000006`，完整请求成本 `2.10000006`，存在 `UNKNOWN` 但 HTTP 成功的记录。
- 多路由详情：完整请求 `1.50000000`、甲渠道匹配 `0.40000000`、乙渠道 `0.60000000`、未分配差额 `0.50000000`；历史价格 1/2/3/4，不读取当前合成价格 999；不暴露历史快照中的私有测试字段。
- `channelModelScope=UNASSOCIATED` 只返回真实缺失关联的两条记录，匹配合计 `1.50000000`，不会扩成全部三条请求。
- 预算：限额 5、已花费 3.5、预留 0.5、待核算 0.5、可用 1；流水 2 条，请求详情与真实流水身份匹配。
- 历史日志与选项允许超过 90 天；无日期的授权详情 UUID 可定位 1 月历史记录。analytics 选项仍拒绝超过 90 天。
- 组织管理员 / 员工访问平台监控返回既有 HTTP 401；外组织详情 HTTP 404；员工不能读他人日志或管理用量组。伪造组织 / 员工筛选只会缩到真实授权范围。

## 参数化 EXPLAIN

执行真实服务所构造的参数化 SELECT，使用 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`；时间范围为上海 2026-06-19 至 2026-09-17，共 90 天。样本固定为 5,001 请求、5,001 路由、5,001 个不同模型，以及当前组织 203 个组。统计更新只在专用本地库执行。

| 查询 | 结果行 / 总数 | 修复前耗时 | 修复后耗时 | 关键扫描与临时块 |
| --- | --- | --- | --- | --- |
| 90 天 channel breakdown | 2 / 2 | 272.976 ms | 273.594 ms | usage_logs 5,001 匹配；全表过滤其他合成记录；路线表顺序扫描，已有 usage_log_id 索引用于逐请求成本；temp read 448 |
| 90 天 priceKey + model，offset 50 / limit 50 | 50 / 5,001 | 12,927.135 ms | 430.124 ms | 同样扫描 5,001 个匹配请求；价格关联由平方级配对变为 Hash Join；temp read 1,825,473 → 473，temp written 1,279 → 914 |
| 预算风险分页，offset 50 / limit 50 | 50 / 202 | 1.022 ms | 1.020 ms | 203 个组织内组，预算周期与已有流水索引；temp read/write 0 |

修复前 EXPLAIN：usage_logs 扫描 6,198 行（5,001 匹配 / 1,197 过滤），route_attempts 扫描 5,871 行。修复后其他集成样本增加：usage_logs 6,284 行（5,001 / 1,283），route_attempts 6,129 行；目标数据集保持不变。两次 shared physical reads 均为 0；这些是本地热缓存结果，不能当作生产容量承诺。没有证据支持新增索引。

## 浏览器验收

主控使用本地管理端、真实登录和上述命名合成样本验收。以下结果由主控实测回传：

- 核算组 analytics 3 请求 / 100% / ¥3.9，缓存 300/360、未知调用 2；甲渠道 / 历史价格筛选下钻均保留作用域并显示两行合计 ¥2.4。
- 抽屉展示完整 / 匹配 / 未分配费用，历史四项价格及跨午夜时段；缺失乙渠道价格如实显示；Escape 关闭并返回“查看”按钮焦点。
- `limit=200&offset=200` 显示 200 行 / 第 2 页，刷新仍保留；5,001 行导出显示明确 400 错误。
- 5,000 行浏览器点击恢复正常且没有 UI 错误，但 CUA 下载事件等待 20 秒超时，未捕获浏览器下载文件；实际文件内容、行数和响应头由上述真实 HTTP 检查证明。
- 显式 1 月至 9 月历史日志可显示单条 ¥0.25、UNKNOWN、HTTP 200 请求成功记录；总览待核算入口使用最早历史时间，下钻不被 90 天上限截断。
- 总览 API / Gateway 健康、真实 P95 与未知值“—”；月份切换只改变统计时间范围，当前告警范围保持；预算告警进入组页保留 ATTENTION + active，耗尽组排在前。
- 浏览器后退实测：渠道 → 日志 → 抽屉关闭 → 后退恢复 analytics 的组和日期，再切价格仍为 ¥2.4；总览 → 历史待核算日志 → 后退返回总览，再打开预算告警。
- 组织管理员只有组织范围导航，直接进入 `/` 转到 `/my-access`；组搜索结合 ATTENTION 筛选得到目标一行，80% 占用与两名有效成员正确。组内模型及设备凭据维度均为 3 请求 / ¥3.9，30 / 90 天切换有效，超过 90 天明确提示，当前预算不随历史日期改变；无匹配组搜索显示空态 0 条。
- 员工没有管理导航，直接进入管理员组 URL 显示无权访问；日志只显示本人两行 / ¥3.5，analytics 为 2 请求 / ¥3.5 / 活跃员工 1 / 缓存 300/350 / 未知调用 1，不包含组织管理员的第三条记录。
- 健康检查故障与重试已人工验证：01:23:44，平台总览的 API / Gateway 均显示可达；主控确认本次拥有的本地后端进程后停止该进程，再分别点击两个健康检查重试按钮，均显示“检查失败 HTTP 500”，并保留“上次成功（非当前成功）01:23:44”。重启相同本地验收服务后再次点击重试，两者于 01:25:24 恢复可达，其他面板保持正常。此故障仅模拟本地服务不可达，不据此声称特定数据库故障已人工验证。
- 错误恢复实测：analytics 明确显示 1 月至 9 月超 90 天错误，点击“近 7 天”后恢复本人 2 请求 / ¥3.5；截图检查布局正常。“清空筛选”按钮为白色原生样式，与深色应用按钮视觉不一致，记录为非阻断的样式改进项。

## 交付状态

实现、真实 PG、HTTP、参数化 EXPLAIN、最终全量回归和上述浏览器流程已完成，包括本地服务不可达后的人工健康检查重试。明确保留一项人工验证限制：浏览器 5,000 行下载事件未捕获；实际 CSV 字节已通过真实 HTTP 验证。独立代码审查由主控安排，本记录不替代该审查。未执行任何生产发布动作。

## 附录：执行期间的 17 项裁定

按执行记录中的顺序保留原文；每项包含决策、原因以及判断错误时的修正成本。仅摘录裁定，不复制本地凭据、连接信息或其他执行流水。

1. Ruling: Task2 may edit analytics.dto.ts for its explicitly required optionDimension/q/pagination fields — shared interface omission in file list — risk if wrong: small DTO diff to revise.

2. Ruling: Task7 request lookup must pass entry startedAt day bounds with requestId — default seven-day log window would hide historical ledger requests — risk if wrong: revise navigation bounds only.

3. Ruling: RECONCILIATION_REQUIRED is an accounting marker, not an operational error when HTTP2xx with no cancellation/interruption — group-request.ts persist writes this marker on otherwise successful UNKNOWN billing; the spec's independent-success requirement overrides generic non-null-error wording — risk if wrong: affected historical success classification must be revised, no accounting mutations.

4. Ruling: New log rows retain full-request costCny for compatibility and additionally expose matchedCostCny; filtered table/CSV/sum checks use matchedCostCny, detail labels both — avoids presenting a full retry cost as cost of one filtered channel — risk if wrong: read DTO/UI labels need adjustment, stored amounts unchanged. Carry to Tasks3/4/9 briefs.

5. Ruling: Add channelModelScope='UNASSOCIATED' mutually exclusive with channelModelId, validated and applied at allocation layer; use it in null-channel-model drillQuery — the approved history/drilldown requirement cannot be expressed by a UUID-only filter — cost if wrong: one optional DTO/filter/UI field to revise, no stored data changes.

6. Ruling: Monitoring role-denial tests preserve existing AuthGuard HTTP401, rather than plan Task8's403 example — packages/security/src/auth.ts already returns UnauthorizedException for role mismatch, and the spec requires existing role boundaries rather than a global status change — cost if wrong: revisit denial status/test expectation, no access expansion.

7. Ruling: filterOptions retains eight legacy collections and adds nullable page; when optionDimension is supplied page={dimension,items,total,limit,offset} and only its collection needs populating — fulfills scoped search/pagination without breaking old collection access — cost if wrong: optional read-response/UI mapping revision, no data or billing changes.

8. Ruling: Move the already-diagnosed Prisma ESM subprocess timeout repair from Task9 into Task3 before its full regression — repeated cold-start flakes otherwise obscure each task's full-suite evidence; still only this test's child timeout5000→15000, not dependencies or global test limits — cost if wrong: a genuine subprocess hang takes up to10s longer to fail, production unchanged.

9. Ruling: Escalate Task2's interrupted fix round1 to a fresh gpt-6-astra implementer now, rather than mechanically resuming the same model — explicit NEEDS_CONTEXT plus unresolved request/allocation architecture after supplied contracts triggers the skill's escalation handling, not a normal completed-fix retry — cost if wrong: extra model/review effort, existing work and scope preserved.

10. Ruling: Provide logs-scoped filter options through /usage/filter-options and reuse the same option implementation with an internal logs mode — analytics filterOptions currently enforces90days, which would break the approved older-history logs/UNKNOWN navigation and requestId-scoped choices; analytics endpoints retain90day bounds, no client flag bypass — cost if wrong: one additive read endpoint and shared UI mode mapping to revise, data scope unchanged.

11. Ruling: Set only the Prisma ESM config test's outer it timeout to20000ms alongside approved child15000ms — actual focused child returned successfully in11864ms but Vitest default5000ms still failed it, so the inner allowance alone cannot work — cost if wrong: this one genuine slow/hung test can take up to20s to fail; no global, dependency or production change.

12. Ruling: Apply hour31day maximum only inside analytics mode of resolveUsageFilter — logs do not time-bucket and their approved explicit historical range must not fail from a carried interval parameter — cost if wrong: revise validation for logs carrying interval; analytics limits and principal scope remain unchanged.

13. Ruling: Project unsafe JSON numeric route tokens as null/incomplete rather than Decimal(number) text; preserve exact string tokens and recorded route cost, with formula null when unsafe — Prisma has already rounded an unsafe JSON number and wrapping it cannot restore precision; no special extra JSONB extraction query for this edge — cost if wrong: unusually huge historical numeric token values display unavailable instead of exact database text; stored data/cost remain intact and a later text-extraction read can restore display.

14. Ruling: Analytics UI blocks incoming requestId/sessionId/projectId filters with a visible explanation and explicit clear action, rather than silently dropping them — actual AnalyticsQueryDto excludes these logs-only filters and cross-page navigation must not silently broaden the represented data — cost if wrong: one extra click before broader analytics, or later add intentional backend support; no query scope expansion or production change now. Carried to Task5 brief.

15. Ruling: Add read-only sort=requestSuccessRate to analytics DTO/SQL and use it for the new UI success column, keeping old successRate sorting unchanged — existing sort targets legacy billing-dependent success_rate and would order a different metric than the displayed operational success rate — cost if wrong: additive enum/SQL alias/UI sort can be revised; no stored costs or billing behavior change. Task5 authorized minimal producer+realPG/DTO tests.

16. Ruling: Abnormal-channel reminder uses two accurately labeled complete-result links for enabled DEGRADED and enabled UNHEALTHY channels, while combined total/top5 retains both — existing Channels UI/API supports one health and both exact destinations cover the requested set without broadening or another interface — cost if wrong: add a combined multi-health channel filter/navigation later; no channel state or data changes. Task8brief carries exact labels/URLs/tests.

17. Ruling: Task8 may update test/catalog/catalog-runtime-isolation.test.ts with the new MonitoringController constructor dependency while retaining existing assertions — a direct test constructor outside the planned file list otherwise fails typecheck after the required service reuse — cost if wrong: one test-fixture argument to revise; no runtime or permission behavior change.
