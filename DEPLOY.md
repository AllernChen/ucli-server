# UCLI Server 部署说明

## 环境要求

- Linux x86_64；Docker Engine 24+；Docker Compose v2。
- 最低 4 核、8 GiB 内存、80 GiB SSD；推荐 8 核、16 GiB、200 GiB SSD。
- 本部署包复用 PostgreSQL、Redis、MinIO，目标容器必须能加入对应 Docker 外部网络。
- 默认占用宿主机 80 端口；正式开放前应由内网网关提供 HTTPS。

## 快速开始

1. 将发布包解压到 `/data/ucli-server`。
2. `cp conf/.env.example conf/.env`，填写真实连接信息与随机密钥。
3. 执行 `chmod +x install.sh && ./install.sh install`。

升级时使用 `./install.sh update`。脚本会先加载 `images/` 镜像，再执行 Prisma 数据库迁移；迁移失败时应用不会启动。

## 镜像加载

`install.sh` 自动加载 `images/*.tar` 与 `images/*.tar.gz`。也可以手动执行：

```bash
docker load -i images/ucli-server-runtime_v0.2.0.tar.gz
docker load -i images/ucli-server-web_v0.2.0.tar.gz
```

## 配置说明

- `DATABASE_URL`：UCLI 专用 PostgreSQL 数据库。
- `REDIS_URL`：配额与运行状态使用的 Redis。
- `MINIO_*`：技能包对象存储配置。
- `MASTER_KEY`：Base64 编码的 32 字节密钥；丢失后渠道 Key 无法解密。
- `JWT_SECRET`：至少 32 位随机值。
- `SETUP_SECRET`：首次创建平台管理员使用，初始化完成后应轮换。
- `PUBLIC_URL`：必须是精确的 UCLI 可访问 origin，例如 `http://IP[:port]`；服务端据此生成浏览器设备授权链接。部署在可信公司内网时允许使用 HTTP，HTTP 以该内网为可信边界，不能用于不可信公网。
- `GATEWAY_PUBLIC_URL`：员工访问的模型网关地址。

`conf/.env` 包含敏感信息，不得提交或打入交付压缩包。

## 验证步骤

```bash
./install.sh status
curl -f http://127.0.0.1/healthz
curl -f http://127.0.0.1/gateway/healthz
```

浏览器访问 `http://<服务器地址>/`，首次部署使用 `/api/v1/auth/setup` 创建平台管理员。

## 设备授权迁移与回滚

此版本是破坏性迁移：升级会删除旧邀请和待审批设备码数据，并撤销旧设备 refresh token。执行 `./install.sh update` 前必须使用仓库标准备份脚本 `./scripts/backup.ps1`（Linux 交付包使用平台既有备份流程）完成数据库备份。

迁移后旧表已不存在，因此二进制回滚不受支持。若必须回退，需一并恢复升级前数据库备份和上一版应用镜像；只回滚应用二进制会导致旧版本无法运行。部署前验证失败时，只回退本功能提交，不使用破坏性工作区重置。

## 常见问题

- 端口冲突：修改 `conf/.env` 中的 `HTTP_PORT`。
- 数据库迁移失败：检查 `DATABASE_URL`、外部网络和用户权限。
- MinIO 不可用：检查容器是否加入 MinIO 外部网络及访问密钥。
- 查看日志：`./install.sh logs api` 或 `./install.sh logs gateway`。

## 联系信息

由公司内部平台运维与研发团队共同维护。
