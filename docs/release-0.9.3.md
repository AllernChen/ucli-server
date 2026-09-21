# 0.9.3 — 普通员工自有 Key 明文查看修复

状态：2026-09-21 已部署公司服务器并通过基础设施与 API 验收；普通员工浏览器人工验收待完成。

## 变更范围

- 修复普通员工个人中心 API Key 详情不显示明文查看入口的问题。
- 员工查看自有 Key 仍必须输入当前登录密码；仅可查看可恢复密文，明文不落缓存、不写入日志。
- 复用已有 `POST /api/v1/me/api-keys/:id/reveal` 能力，不扩大员工管理接口权限。
- 明文显示后支持复制；关闭详情立即清空明文。

## 验证

- typecheck 通过。
- 完整 `verify` 门禁通过：928 项测试全部通过，语句/行覆盖率 93.83%，分支 85.38%，函数 97.34%。
- 管理端构建通过。
- 许可证检查通过。
- CI `35552051281` 在源码提交 `69b8ff9128ccacca912b69d002cb47b6d9057bd2` 上三项 job 全绿：
  [CI 运行记录](https://github.com/AllernChen/ucli-server/actions/runs/35552051281)。

## 发布件

- 离线包：`F:\projects\ucli-server\releases\ucli-server_0.9.3_20260921_69b8ff9.tar.gz`
- 离线包大小：`209,642,686` 字节
- 离线包 SHA-256：`193dc571d908ec60b4fc09b34c21fa40b4516a1f3ace651a9e292ba29b569627`
- Runtime 镜像：`ucli-server-runtime:0.9.3`
  `sha256:6735b20b2a12a265451492be57e7425f342d632a040078dd05d893fd5522068a`
- Web 镜像：`ucli-server-web:0.9.3`
  `sha256:199006a662e1af6fdadfd67a0fd2d8c876f0cd32d7e364f96d2b10aa064f136b`
- 包内校验通过；未包含 `.env`、数据库备份、凭据或私钥。

## 公司部署记录

- 部署时间：2026-09-21。
- 目标：`http://10.44.100.100`，部署目录 `/data/ucli-server`。
- 升级前版本：`0.9.2`，源码提交 `1df27fa57e692bd2eb59a813f23bb5896f8a1a08`。
- 升级后版本：`0.9.3`，源码提交 `69b8ff9128ccacca912b69d002cb47b6d9057bd2`。
- 升级前成对备份：
  `/data/ucli-server/backups/production-092-1df27fa-before-093-69b8ff9-20260921`。
  - PostgreSQL 备份 `ucli.dump`
    SHA-256：`772e00cd76b794a578cef7dbea9a28aee6a3491a8138159bab3538e42e91f926`
  - 0.9.2 镜像归档 `ucli-server-0.9.2-images.tar.gz`
    SHA-256：`55020c796f5ed7ef8a3650e168bda9a8c0fd8fab188f1bb8f1393d77811ba77e`
  - 发布控制文件、镜像清单、容器状态与全套 SHA-256 已随备份保留。
- 执行方式：`./install.sh update`。
- 迁移结果：21 个迁移已加载，无待执行迁移。
- 部署后 API healthz：`ok`，PostgreSQL 与 Redis 均为 `ok`。
- 部署后 Gateway healthz：`ok`，PostgreSQL 与 Redis 均为 `ok`。
- 外部页面 `http://10.44.100.100/` 返回 HTTP 200。
- 四个应用容器均运行 0.9.3；runtime 镜像 ID 与 Web 镜像 ID 和发布件一致。
- 生产前端加载的 `index-BECIBV82.js` 包含普通员工自有 Key 明文查看入口标记。
- `org-project-access-coverage.mjs --dry-run` 显示 87 个目标关系；缺失项目成员 0，缺失有效 Key 0。

## 剩余事项

- 普通员工浏览器人工验收待完成：用员工账号登录个人中心 → API Keys → 详情，确认输入当前密码后明文显示、可复制、关闭后清空。

## 回滚

无数据库迁移。如需回滚，恢复 0.9.2 数据库备份和 runtime/web 镜像，并保留原 `MASTER_KEY`。
