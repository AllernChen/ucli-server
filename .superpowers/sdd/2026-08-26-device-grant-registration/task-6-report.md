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
