# 0.9.4 — 侧边栏底部操作布局修复

状态：2026-09-21 已部署公司服务器并通过基础设施验证；浏览器人工复核待完成。

## 变更范围

- 修复“个人中心”和“退出登录”同时使用 `margin-top:auto` 导致两者被分配剩余空间、在侧边栏中分散显示的问题。
- 现在菜单项仍从顶部排列；“个人中心”用剩余空间推到底部，“退出登录”紧随其后。
- 小屏下侧边栏转为普通布局时，两项仍保持相邻。

## 验证

- typecheck 通过。
- 完整 `verify` 门禁通过：929 项测试全部通过，语句/行覆盖率 93.83%，分支 85.39%，函数 97.34%。
- 侧边栏身份与视觉样式定向测试通过。
- 管理端构建通过。
- 许可证检查通过。
- CI `35554262915` 在源码提交 `0cd5808afe319ed16204965566bc6fb8c9abe3be` 上三项 job 全绿：
  [CI 运行记录](https://github.com/AllernChen/ucli-server/actions/runs/35554262915)。

## 发布件

- 离线包：`F:\projects\ucli-server\releases\ucli-server_0.9.4_20260921_0cd5808.tar.gz`
- 离线包大小：`210,379,161` 字节
- 离线包 SHA-256：`1d778f1eed355922e2c8c175cc97043799838e47fb1aa78c5a5080d8e633fb19`
- Runtime 镜像：`ucli-server-runtime:0.9.4`
  `sha256:86ebd054b8bc10e4275a61897c12b55dff75868042d4d030379b4c01f77977fe`
- Web 镜像：`ucli-server-web:0.9.4`
  `sha256:7a22f4e7bee46ccce44ba8bfafda2873151069d4c146cbb5f198e259109febbd`
- 包内校验通过；未包含 `.env`、数据库备份、凭据或私钥。

## 公司部署记录

- 部署时间：2026-09-21。
- 目标：`http://10.44.100.100`，部署目录 `/data/ucli-server`。
- 升级前版本：`0.9.3`，源码提交 `69b8ff9128ccacca912b69d002cb47b6d9057bd2`。
- 升级后版本：`0.9.4`，源码提交 `0cd5808afe319ed16204965566bc6fb8c9abe3be`。
- 升级前成对备份：
  `/data/ucli-server/backups/production-093-69b8ff9-before-094-0cd5808-20260921`。
  - PostgreSQL 备份 `ucli.dump`
    SHA-256：`40abfecbda58093fe3b693e881439024ab61ef8411f57a386e9381e21ca4b0ef`
  - 0.9.3 镜像归档 `ucli-server-0.9.3-images.tar.gz`
    SHA-256：`f377029ac5835e6333de60c8634f9c0e38b4d860cab42fba80daeedc09cf5478`
  - 发布控制文件、镜像清单、容器状态与全套 SHA-256 已随备份保留。
- 执行方式：`./install.sh update`。
- 迁移结果：21 个迁移已加载，无待执行迁移。
- 部署后 API healthz：`ok`，PostgreSQL 与 Redis 均为 `ok`。
- 部署后 Gateway healthz：`ok`，PostgreSQL 与 Redis 均为 `ok`。
- 外部页面 `http://10.44.100.100/` 返回 HTTP 200。
- 四个应用容器均运行 0.9.4；runtime 镜像 ID 与 Web 镜像 ID 和发布件一致。
- 生产前端 CSS 包含 `.account{margin-top:auto}`，且 `.logout` 不再各自分配剩余空间。

## 剩余事项

- 浏览器人工复核待完成：确认不同角色菜单下的侧边栏中，“个人中心”和“退出登录”相邻并稳定贴底。

## 回滚

无数据库迁移。如需回滚，恢复 0.9.3 数据库备份和 runtime/web 镜像，并保留原 `MASTER_KEY`。
