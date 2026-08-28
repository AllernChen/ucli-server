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

## 设备授权迁移前置检查

设备授权升级包含破坏性删除；在任何 `./install.sh update` 或手工迁移操作前，必须完成以下步骤：

1. 在与生产版本和扩展一致的 staging 数据库执行 staging rehearsal，确认迁移、应用启动和 UCLI 重新注册流程。
2. 从新鲜生产备份隔离恢复 staging 数据库后，运行下面的外部依赖预检。它按 `public` schema 的 `DeviceCodeStatus` OID 查询 `pg_depend`，用 `pg_describe_object` 列出依赖，并仅排除内部数组类型依赖、`public.device_authorizations` 的已知状态列依赖及其 `pg_attrdef` 默认值依赖：

   ```sql
   WITH target_type AS (
     SELECT 'public."DeviceCodeStatus"'::regtype::oid AS type_oid
   ), known_dependencies AS (
     SELECT d.classid, d.objid, d.objsubid
     FROM pg_depend AS d
     CROSS JOIN target_type AS target
     LEFT JOIN pg_type AS array_type ON array_type.oid = d.objid
     LEFT JOIN pg_class AS relation ON relation.oid = d.objid
     LEFT JOIN pg_namespace AS relation_schema ON relation_schema.oid = relation.relnamespace
     LEFT JOIN pg_attribute AS attribute
       ON attribute.attrelid = relation.oid AND attribute.attnum = d.objsubid
     LEFT JOIN pg_attrdef AS attribute_default ON attribute_default.oid = d.objid
     LEFT JOIN pg_class AS default_relation ON default_relation.oid = attribute_default.adrelid
     LEFT JOIN pg_namespace AS default_schema ON default_schema.oid = default_relation.relnamespace
     LEFT JOIN pg_attribute AS default_attribute
       ON default_attribute.attrelid = default_relation.oid AND default_attribute.attnum = attribute_default.adnum
     WHERE d.refclassid = 'pg_type'::regclass
       AND d.refobjid = target.type_oid
       AND (
         (d.deptype = 'i' AND d.classid = 'pg_type'::regclass AND array_type.typelem = target.type_oid)
         OR (d.classid = 'pg_class'::regclass AND relation_schema.nspname = 'public'
             AND relation.relname = 'device_authorizations' AND attribute.attname = 'status')
         OR (d.classid = 'pg_attrdef'::regclass AND default_schema.nspname = 'public'
             AND default_relation.relname = 'device_authorizations' AND default_attribute.attname = 'status')
       )
   )
   SELECT pg_describe_object(d.classid, d.objid, d.objsubid) AS dependent_object
   FROM pg_depend AS d
   CROSS JOIN target_type AS target
   WHERE d.refclassid = 'pg_type'::regclass
     AND d.refobjid = target.type_oid
     AND NOT EXISTS (
       SELECT 1 FROM known_dependencies AS known
       WHERE (known.classid, known.objid, known.objsubid) = (d.classid, d.objid, d.objsubid)
     )
   ORDER BY dependent_object;
   ```

   预期严格 0 行。任何行禁止升级：先识别并迁移该对象，重新从生产备份恢复后再预检。未知依赖会使默认 `DROP TYPE "DeviceCodeStatus"` 的 `RESTRICT` 行为失败。
3. 执行仓库标准数据库备份：开发仓库使用 `./scripts/backup.ps1`，Linux 交付包使用平台既有备份流程，并确认上一版应用镜像可用。备份必须与升级前应用镜像成对保留。

迁移脚本以显式事务执行。若预检遗漏的依赖导致 `DROP TYPE` 失败，事务整体回滚，不会留下部分删除的表或部分新 schema。

设备授权链接迁移顺序不可调整：`202608270001_device_grant_links_expand` 先建立链接历史并回填，`202608270002_device_grant_links_contract` 再删除旧令牌列，最后执行 `202608270003_device_grant_link_issuance_order` 为历史和后续链接建立签发顺序。新数据库安装会按目录排序执行这三个迁移；已有数据库必须按上述顺序升级。

## 镜像加载

`install.sh` 自动加载 `images/*.tar` 与 `images/*.tar.gz`。也可以手动执行：

```bash
docker load -i images/ucli-server-runtime_v0.3.0.tar.gz
docker load -i images/ucli-server-web_v0.3.0.tar.gz
```

## 配置说明

- `DATABASE_URL`：UCLI 专用 PostgreSQL 数据库。
- `REDIS_URL`：配额与运行状态使用的 Redis。
- `MINIO_*`：技能包对象存储配置。
- `MASTER_KEY`：Base64 编码的 32 字节密钥；丢失后渠道 Key 和已保存的设备连接 URL 无法解密。升级、备份恢复、故障切换和滚动发布必须保持连续的同一值，不能在恢复时临时更换。
- `JWT_SECRET`：至少 32 位随机值。
- `SETUP_SECRET`：首次创建平台管理员使用，初始化完成后应轮换。
- `PUBLIC_URL`：必须是精确的 UCLI 可访问 origin，例如 `http://IP[:port]`；服务端据此生成浏览器设备授权链接。部署在可信公司内网时允许使用 HTTP，HTTP 以该内网为可信边界，不能用于不可信公网。
- `GATEWAY_PUBLIC_URL`：员工访问的模型网关地址。

Responses 客户端上线前，平台管理员必须创建独立的 `OPENAI_RESPONSES` 通道和模型映射，使用供应商 Responses API 对应的 base URL，并在管理端重新输入供应商密钥。不得复用带 `/anthropic` 的 Anthropic Messages base URL，也不得从数据库或现有通道提取密钥。模型测试通过且价格有效后才能启用映射。

`conf/.env` 包含敏感信息，不得提交或打入交付压缩包。

## 验证步骤

```bash
./install.sh status
curl -f http://127.0.0.1/healthz
curl -f http://127.0.0.1/gateway/healthz
```

浏览器访问 `http://<服务器地址>/`，首次部署使用 `/api/v1/auth/setup` 创建平台管理员。

## 设备授权迁移与回滚

此版本会删除旧邀请和待审批设备码数据，并撤销旧设备 refresh token；旧客户端与旧邀请、设备码和旧 refresh token 协议不兼容，必须升级到当前客户端注册链接流程。迁移后旧表已不存在，因此二进制回滚不受支持。若必须回退，回滚必须同时恢复与上一版应用镜像匹配的升级前数据库备份和上一版应用镜像；只回滚应用二进制会导致旧版本无法运行。恢复时继续使用备份对应的 `MASTER_KEY`。部署前验证失败时，只回退本功能提交，不使用破坏性工作区重置。

## 常见问题

- 端口冲突：修改 `conf/.env` 中的 `HTTP_PORT`。
- 数据库迁移失败：检查 `DATABASE_URL`、外部网络和用户权限。
- MinIO 不可用：检查容器是否加入 MinIO 外部网络及访问密钥。
- 查看日志：`./install.sh logs api` 或 `./install.sh logs gateway`。

## 联系信息

由公司内部平台运维与研发团队共同维护。
