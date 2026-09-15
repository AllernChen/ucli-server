# 0.4.0 公司发布记录

2026-09-15 15:04（Asia/Shanghai）通过 `./install.sh update` 升级；15:08 复核四容器运行、重启次数均为 0。生产基础设施及只读存储验证通过；本轮未完成真实客户端全链路验收。

## 发布身份

- 源提交：`b1f5312f1c49e721991204e146acff44b539d752`，已快进合并到本地 `main`。
- 版本：`0.4.0`；目标：`root@10.44.100.100:/data/ucli-server`。
- Runtime：`ucli-server-runtime:0.4.0`，ID `sha256:d1177839efcef7e5fe76a6914482ff0a8ac561d9f931491d7a373287c6b5b6b8`。
- Web：`ucli-server-web:0.4.0`，ID `sha256:3a063c0e9c39c7b3f0ad58e9a3b61f6e0e087f58366f24bbd9706f4211d1d04d`。
- 交付包：`releases/ucli-server_0.4.0_20260915_b1f5312.tar.gz`（208655087 字节）。
- 包 SHA-256：`06108bb0f6fea1168ba4f733e1fecf447864009e8f44f1a583606c808edf98e6`。
- 从干净提交 `git archive` 构建；只交付部署文件、两个镜像、RELEASE 和 SHA256SUMS，不含真实 `.env`、密钥、数据库或本地数据。远端验证了外层包及全部内层文件校验和。
- 本记录为部署后文档，不属于上述镜像源提交；本轮未推送远程 Git，也未创建发布标签。

## 验证结果

- 发布前完整验证及合并后 `npm run verify` 均通过：110 个测试文件、664 项测试；TypeScript、服务端构建、管理端构建、452 项许可证记录检查通过。覆盖率约 95.96% 行/语句、85.12% 分支、97.77% 函数。
- 发布前再次运行 Group HTTP、Employee Key HTTP、Skills storage HTTP：全部通过；包含真实本地 PostgreSQL、Redis、MinIO，多协议流式/工具调用、预算并发与对象上传下载哈希检查。
- 官方 npm registry 的生产依赖审计：0 漏洞。包含开发依赖的审计仍有 4 项已记录问题，见 [依赖审查](dependency-security-review.md)；未无关升级工具链。
- 新鲜生产备份恢复至内网隔离的 PostgreSQL，版本和扩展与生产一致。确认历史 `DeviceCodeStatus` 已不存在、15 项旧迁移完成，仅应用 `202609140001_group_access_budget`，变为 16 项。
- 23 张历史表旧字段的行数及内容指纹在迁移前后完全一致；不会自动归组、分配预算或启用员工 Key。
- 隔离 HTTP 验证：组/成员/人民币预算管理、设备 preview/redeem/refresh/bootstrap、空组模型目录、撤销后 401、新版 Web 与健康代理通过。仅操作隔离库的合成账号，不访问真实上游。
- 回滚演练：同一份迁移前备份恢复到独立 `ucli_rollback` 数据库，15 项迁移和历史数据指纹一致，0.3.2 API/Gateway 成功启动且健康。没有将旧镜像连接到升级后数据库。未演练旧版 Worker/Web 或完整真实客户端回滚。
- 正式升级前再次备份，并在隔离 PostgreSQL 的 `ucli_predeploy` 库成功恢复此最新备份，再执行升级。
- 正式升级后：API/Gateway/Worker/Web 的实际 image ID 与 RELEASE 完全一致；API/Gateway 健康且 PostgreSQL/Redis 均正常；数据库 16 项迁移完成。
- 服务端及工作站 HTTP：首页 200、SPA 根节点存在、API/Gateway 健康；未认证模型请求 401、员工 Key 入口关闭请求 403。
- 生产 MinIO 只读检查通过：新 S3 SDK 获取桶区域/读取桶，读取一个现有已发布技能包并与数据库记录核对大小和 SHA-256；没有创建或修改对象、技能、账号或业务配置。

## 配置、备份与保留

用户明确授权仅将生产 `conf/.env` 的 `VERSION=0.3.2` 改成 `VERSION=0.4.0`。将新版文件内该行反向替换后，整个文件的 SHA-256 与原文件一致；升级后再次验证配置哈希。因此包括 MASTER_KEY 在内的其他配置和所有密钥保持不变。员工 API Key 入口继续关闭。

以下路径均位于 `/data/ucli-server` 内；备份和隔离目录采用仅属主访问权限：

- 演练备份：`backups/040-b1f5312/ucli.dump`，SHA-256 `3e5d94ba4b7e843fc5e3b74a47e2e07de1c7607f1307dbae94d3e4114e284c25`。
- 紧邻生产升级前备份：`backups/production-040-b1f5312/ucli.dump`，SHA-256 `f976dafcccee33460371ae19fbd5059682c387d8f70072cabac12e043d5f2fa7`。
- 同目录保留旧 RELEASE、校验清单、安装器、Compose、镜像身份记录、配置连续性哈希和升级日志；旧版 0.3.2 镜像与原有镜像归档均保留。
- 演练证据：`rehearsal/040-b1f5312/`；所有本次演练容器已停止，无宿主机端口，仅连接专属 internal 网络。保留隔离数据库、容器、网络和证据，没有删除已有备份或旧演练材料。
- 上传包及独立校验过的辅助脚本：`incoming/040-b1f5312/`。

回滚仍按 [DEPLOY.md](../DEPLOY.md) 执行：匹配的升级前数据库备份、旧镜像和原 MASTER_KEY 必须成对恢复；不直接清零预算账本或强行只降级二进制。备份之后产生的新业务数据须在决定回滚前单独评估。

## 验收边界

- 本轮浏览器自动打开/读取内网页面均超时，不能把工作站 HTTP 200 等同于浏览器渲染验收。
- 本轮没有执行生产员工 Key、真实渠道付费推理、真实 UCLI 注册/流式对话或带权限的 Skills HTTP 下载验收；现有对象的存储读取不等同于客户端权限链路验收。
- Claude 交互模型选择器的既有外部联网问题见 [员工网关验收](employee-gateway-acceptance.md)。
- 后续启用 Key、建组、成员绑定、模型分配、预算和旧设备首次归组属于独立业务配置，需要单独确认；本次发布不自动实施。
