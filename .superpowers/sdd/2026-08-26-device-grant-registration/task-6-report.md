# Task 6 报告：公开浏览器连接页

## 完成内容

- 新增公开的 `/connect` 页面：令牌仅从 URL fragment 读入内存，随即用 `history.replaceState` 移除 fragment。
- 页面通过无 Bearer、无登录重载副作用的 `publicApi` 以 JSON POST 请求授权预览；页面不渲染、记录或在错误中回显原始令牌。
- “连接 UCLI”和“复制连接链接”均仅在用户点击时从内存中的令牌重建 `ucli://connect?server=<origin>#token=<token>`；复制按钮不会展示原始链接。
- 新增 URL helper，规范化服务端 origin、正确编码参数，并拒绝非 HTTP/HTTPS 协议。
- `/connect` 使用 `meta.public` 进入公开壳层；移除旧 `/invite`、`/device` 路由及对应页面，不保留兼容入口。

## 测试与验证

- TDD RED：`npx vitest run test/admin/device-grant-connect.test.ts` 在 helper 尚不存在时按预期失败。
- Focused：`npx vitest run test/admin/device-grant-connect.test.ts`（5 passed）。
- 类型检查：`npm run typecheck`（passed）。
- 管理后台构建：`npm run admin:build`（passed）。
- 全量单测：`npm test -- --reporter=dot`（69 files / 406 tests passed）。
- 静态安全检查覆盖 token 不进入 DOM/console/query 解析路径，以及公开 API 不注入 Authorization、不清理管理员 storage。

## 备注

一次与构建、类型检查并行执行的全量测试使 `archive-line-endings` 在 5 秒内超时；该测试单独复现通过，随后串行全量测试全部通过，因此未修改无关部署测试。

## 审查修复：浏览器动作状态门控

- 新增纯状态映射：仅 `AVAILABLE` 返回可连接状态；`DISABLED`、`EXPIRED`、`DELETED`、`BOUND` 和未知状态均返回不可操作的中文说明。
- `BOUND` 明确提示“授权已绑定设备，不能用于其他设备。”；浏览器页不再提供连接或复制动作，已唤起 UCLI 的同安装 ID 重试仍由客户端处理。
- 页面使用中文状态标签和说明，不再仅展示后端枚举；连接和复制操作同时在模板和事件处理函数中受 `canConnect` 限制。
- 验证：`npx vitest run test/admin/device-grant-connect.test.ts`（7 passed）、`npm run typecheck`、`npm run admin:build` 均通过。

## 终态复审修复：动作前授权重验

- 连接和复制链接动作共用 `revalidateGrantAction`：每次动作前都以仅存于内存的令牌 POST 授权预览，并以最新预览更新页面状态。
- 仅最新状态为 `AVAILABLE` 时继续跳转或写入剪贴板；最新状态为禁用、已绑定、已过期、已删除、未知或预览失败时均安全关闭，不执行动作。
- 重验 helper 吞掉上游异常并返回不含令牌的未知不可操作状态；服务端 redeem 校验仍是最后的并发竞态防线。
- 验证：`npx vitest run test/admin/device-grant-connect.test.ts`（9 passed）、`npm run typecheck`、`npm run admin:build` 均通过。
