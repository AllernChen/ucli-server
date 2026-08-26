# Task 7 报告：用户与设备授权管理界面

## 完成内容

- 新增用户管理页：创建、搜索、分页、用户详情跳转，以及仅对 `MEMBER` 成员关系执行的启用/禁用操作；用户状态使用后端 `Membership.status` 响应字段。
- 新增用户详情页：显示设备与授权摘要，并可创建默认永久或指定有效期的设备授权。
- 授权创建成功后仅在一次性弹窗内展示完整连接链接并支持复制；弹窗明确提示“关闭后无法再次查看完整令牌”，关闭、出错和组件卸载都会清空 secret state。令牌未写入 console、storage 或 URL。
- 新增按用户分页聚合的授权令牌页：状态与搜索过滤使用 `URLSearchParams` 编码，支持有效期更新、转永久、禁用、启用和删除。删除明确提示“关联设备将被永久撤销”，禁用说明可通过重新启用恢复；`DELETED` 授权无操作入口。
- 新增共享 UI helper，集中授权状态标签、可用生命周期动作、有效期 ISO/null payload 与过滤 query 构造。
- 增加用户/授权路由和侧栏导航，导入局部样式；治理页移除旧成员邀请及直接设备管理，仅保留配额与审计。

## 测试与验证

- TDD RED：`npx vitest run test/admin/device-grant-management.test.ts test/admin/device-grant-views.test.ts` 在 helper 和视图不存在时失败。
- Focused：`npx vitest run test/admin/device-grant-management.test.ts test/admin/device-grant-views.test.ts test/admin/model-form-errors.test.ts`（3 files / 12 tests passed）。
- 相关管理端全量：`npx vitest run test/admin`（10 files / 83 tests passed）。
- 类型检查：`npm run typecheck`（passed）。
- 管理端构建：`npm run admin:build`（passed；Vite 仅报告既有 Analytics chunk 大小警告）。
- 静态检查：`git diff --check`（无 whitespace errors）；治理页不再包含旧邀请、成员或设备管理 endpoint，新增视图无 console/storage/URL secret 路径。
