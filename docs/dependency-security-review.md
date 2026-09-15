# 依赖安全核查（2026-09-15）

范围：`codex/group-access`，基于 67f8151 后的本地修改；只修改本地源码和依赖，不访问或升级公司生产服务。官方 npm registry 的生产依赖审计由 **15 项，经 7 项、4 项，降为 0 项**。此前计数含父依赖归因。包含开发依赖的审计仍为 **4 项（1 high / 3 moderate）**；生产依赖清零不代表开发依赖、容器镜像或全系统安全审计通过。

开发依赖残留为 glob CLI 命令执行告警（high）以及 Vitest / @vitest/mocker / @vitest/coverage-v8 的路径读取告警归因（3 moderate）。本轮只替换存储客户端，没有升级测试框架或默认接受这些风险。[glob 公告](https://github.com/advisories/GHSA-5j98-mcp5-4vw2)、[Vitest 公告](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)。

## 已处理

| 路径 | 修改及依据 |
| --- | --- |
| 管理员技能 ZIP 上传 | `adm-zip` 0.5.18 → 0.6.1，覆盖已公布的读取内存分配和符号链接问题；服务端实际使用内存读取，不解压到磁盘。[维护方发布](https://github.com/cthackers/adm-zip/releases/tag/v0.6.1)、[内存告警](https://github.com/advisories/GHSA-xcpc-8h2w-3j85) |
| NestJS multipart 上传 | 仅将 `@nestjs/platform-express` 下的 multer 定向覆盖为 2.3.0，保留 NestJS 11，不按 audit 建议跨主版本升级框架。后续 NestJS 11 自带修复版时可移除覆盖。[维护方修复发布](https://github.com/expressjs/multer/releases/tag/v2.3.0) |
| Swagger / YAML | 同主版本更新 `@nestjs/swagger` 11.4.6 → 11.4.7，其依赖 js-yaml 5.2.1 → 5.3.0。[YAML 告警](https://github.com/advisories/GHSA-pm4m-ph32-ghv5) |
| Express 查询解析 | 锁文件中的 qs 6.15.3 → 6.16.0，保留上游兼容范围。[查询解析告警](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) |
| Prisma 配置合并 | 保留 Prisma / @prisma/config 6.19.3，仅将其 deepmerge-ts 7.1.5 定向覆盖为 8.0.0，消除循环引用栈耗尽及其两项父依赖归因。8.0.0 保留 CJS/ESM 双入口；其 Map 深合并、into 和类型接口变化不涉及本项目的普通配置对象。[维护方发布](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0)、[安全公告](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)。上游 Prisma 自带修复依赖且复验通过后可移除此覆盖。 |
| MinIO 客户端 | 经用户明确批准，将 minio 8.0.7 替换为 @aws-sdk/client-s3 3.1132.0，删除旧客户端及其漏洞链，不强制覆盖不兼容传递依赖。MinIO 服务、MINIO_* 配置、桶、对象路径和数据不变。[官方 S3 SDK 示例](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html) |

调用链复核发现 `SkillsController.version` 在调用扫描器前就执行了 `entry.getData()`，原有数量、总大小及单文件限制不能阻止提前解压。改为延迟读取内容，扫描器先检查文件数量/声明总大小、路径/符号链接/扩展名及单项大小，再读取一次内容，最后核对实际长度与哈希。没有提高原有限额。

回归使用小 ZIP 修改中央目录声明大小，并拦截大内存分配及解压操作，避免测试本身分配恶意大内存。旧代码先失败于实际 ZIP 读取中的分配尝试；修改检查顺序后通过。HTTP/Nest/multipart/ZIP 上传回归最初使用数据库及存储替身；本轮已将存储改为真实独立本地 MinIO，并补充 HTTP 下载验证，数据库仍为内存替身，不连接公司服务。

Docker 验证发现 `.dockerignore` 漏掉本地 `data/`，构建上下文达到约 884 MB。新增一行排除，避免本地数据库、演练包及结果进入 Docker 构建上下文；不删除这些文件，不修改 Dockerfile。

## 已移除的 MinIO 客户端漏洞链（替换前核查记录）

以下记录保留当时的可达性判断与替换理由；这些包现已从项目锁文件移除，不再是当前生产依赖告警。

| 底层告警 / audit 归因 | 当前调用路径判断 | 后续要求 |
| --- | --- | --- |
| decode-uri-component（moderate），向上归因 query-string、minio | MinIO 8.0.7 的实际源码调用 query-string.stringify，未发现调用其 parse/decode 的路径；本项目仅调用 bucketExists/makeBucket/putObject/getObject。[维护方公告](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr) | 修复版 0.5.0 超出当前依赖范围，不能仅为 audit 清零强制替换而不验证模块接口；等待兼容 SDK 修复或单独验证替代方案。 |
| stream-json（moderate），同样向上归因 minio；MinIO 链总计 4 项 | 危险代码是 pick/ignore/filter/replace 路径过滤器；MinIO 使用 jsonl/Parser 做事件通知，本项目没有调用事件监听接口。[维护方公告](https://github.com/advisories/GHSA-528h-pc64-c93x) | 修复版 3.5.0 跨越当前 1.9.1 的主版本，不能直接覆盖而不验证 SDK 导入路径和运行兼容性；不要新增危险过滤器入口。 |

以上是针对替换前源码的静态可达性判断，不代替完整安全审计。没有添加 audit 忽略清单、降低严重性阈值或将 Prisma 移出生产依赖来隐藏报告，也没有默认接受剩余风险。

2026-09-15 查询官方 registry：MinIO 最新版仍是 8.0.7，依赖 query-string ^7.1.3 / stream-json ^1.8.0。decode-uri-component 修复版 0.5.0 改为 ESM 默认导出，query-string 7 则按 CJS 可调用函数使用；stream-json 3.5.0 也改为 ESM（Node >=22），MinIO 仍以 `require('stream-json/jsonl/Parser.js')` 使用旧 API。因此先停止强行覆盖，完成替换评估，用户随后明确批准更换客户端并做本地验证。

本轮 `test/dependencies/prisma-config.test.ts` 从实际 @prisma/config 的依赖路径解析合并器，旧版对两个微小循环对象出现 `RangeError: Maximum call stack size exceeded`，8.0.0 正常合并且保留循环关系；另一条通过真实配置加载器验证 ESM 导入和 schema/migrations 路径。回归已随既有 `npm run verify` 自动纳入，无需新增 CI 作业。

## S3 替换的兼容边界

- 继续显式使用原 MINIO_* 环境变量和静态凭据、path-style 端点，不读取默认 AWS 账户配置，不迁移对象。首次访问发现桶 Region 后缓存，只有 404 才建桶，并发建桶仅容忍 BucketAlreadyOwnedByYou；403、网络错误和其他服务错误继续失败。
- Buffer 上传保留大小和二进制内容类型，显式 Content-MD5 校验；requestChecksumCalculation 使用 WHEN_REQUIRED 以避免旧服务的可选 CRC 编码兼容问题，没有关闭 TLS 或移除载荷校验。[官方校验说明](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html)。下载返回 Node Readable，不整文件缓存；Nest 销毁存储服务时关闭 SDK 连接池。
- 新增 test/storage/object-storage.test.ts，使用固定版本、随机名称/凭据及 loopback 随机端口的临时 MinIO，覆盖默认/自定义 Region、20 MiB 对象、特殊字符 Key、新实例读取、并发首次上传、缺失对象和错误凭据。现有技能 HTTP 脚本也改用真实 MinIO，验证上传/哈希、未发布 404、发布后的下载响应头与字节。测试容器和匿名卷在 finally/afterAll 删除，仅包含合成测试数据；镜像留作后续回归缓存。
- Docker Hub 拉取原版本被拒绝，改从官方 Quay 获取同一版本；首次网络 EOF，重试成功。镜像 quay.io/minio/minio:RELEASE.2025-07-23T15-54-02Z，摘要 sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0。没有修改项目 Compose 中的生产/开发镜像版本。
- 替换前生产 audit 为 4 moderate、退出 1，替换后为 0、退出 0；未将“审计清零”替代真实存储测试。独立只读审查未发现存储实现和升级后 HTTP 回归的实质问题。

## 最新全量复验（2026-09-15 14:29）

- 干净 npm ci 与 Prisma generate 通过；本地 ucli_test_group_verified 库的 16 条迁移无待执行项。没有 schema、迁移或生产配置修改。
- 原样 npm run verify 退出 0：110 文件、664 项全部通过，无跳过。行/语句覆盖率 95.96%、分支 85.12%、函数 97.77%；新增 6 项真实 MinIO 回归包含在默认测试中。Docker nginx 构建用例通过（约 102 秒），服务端/管理端构建及 452 条许可证检查通过，既有 Analytics 包体积提示不变。
- 同一构建产物依次执行 group-http.mjs、employee-key-http.mjs、skills-upload-http.mjs 均成功。前两者覆盖本地 PG/Redis 的组/Key/预算和三协议模拟上游；最后一条覆盖真实本地 MinIO 的 ZIP 上传到 HTTP 下载全链路，没有使用存储替身。
- 最后官方生产 npm audit 退出 0、found 0 vulnerabilities；npm ls 确认只有 @aws-sdk/client-s3 3.1132.0，旧 minio / query-string / decode-uri-component / stream-json 已移除。包含开发依赖的 audit 仍退出 1（4 项），未隐藏。
- 14:29:44 正常停止 PG/Redis、保留原测试库数据，55439/56389 不再监听。确认本轮临时 MinIO 容器均已删除，其匿名卷仅含合成测试对象，按测试清理逻辑移除；没有生产文件被删除，测试镜像保留缓存。
- 本轮未提交、合并、推送、制作正式发布包、部署生产或调用付费模型。只完成经批准的客户端替换和本地验证；原服务器继续使用原服务与数据。

## 前轮全量复验（2026-09-15 13:21）

- `npm ci --registry=https://registry.npmjs.org` 干净安装及显式 `npm run db:generate` 成功，Prisma 仍为 6.19.3；专用本地库 16 条迁移无待执行项。
- 原样 `npm run verify` 退出 0：109 文件、658 项全部通过，无跳过；行/语句 95.96%、分支 85.12%、函数 97.77%。服务端/管理端构建与 455 条许可证检查通过，保留既有 Analytics 包体积提示。Docker nginx 健康路由用例通过（约 102 秒），未调整并发、超时或覆盖率门槛。
- 同一轮构建后串行执行三条 HTTP 回归全部成功：组权限、员工 Key 的三协议/流式/工具往返及 PG/Redis 预算结算、技能 ZIP/multipart/Swagger。推理仍为本地模拟上游，未做生产付费调用或真实 MinIO 上传下载验收。
- 独立只读复核未发现本轮 Prisma 定向覆盖或两条新回归的实质问题。干净安装后的官方生产依赖审计仍为 4 moderate、0 high/critical，退出 1；没有将功能验证通过等同于安全门禁通过。
- 13:21:46 正常停止本轮 PG/Redis，55439/56389 均不再监听，保留测试数据。本轮未提交、合并、推送、制作正式包或部署生产。继续消除 MinIO 残留需要确认客户端替换范围；不默认接受风险。

## 前轮全量复验（2026-09-15 13:06）

- 用户继续后，通过 Windows 隐藏进程启动已有本地 PG 16.11（127.0.0.1:55439）和测试 Redis（127.0.0.1:56389/15）。初次迁移连接误用了不存在的 postgres 角色，日志和原有测试脚本确认实际用户为 ucli_test，修正连接参数后成功；未改账户、权限或迁移内容。
- 测试连接明确为 `postgresql://ucli_test@127.0.0.1:55439/ucli_test_group_verified`。Prisma 客户端生成通过，数据库已有 16 条迁移，无待执行项。
- 原样 `npm run verify` 退出 0：108 文件、656 项测试全部通过，无跳过/排除；行/语句覆盖率 95.96%、分支 85.12%、函数 97.77%。类型检查、服务端和管理端构建、455 条包许可证检查通过，保留既有管理端 Analytics 包体积告警。默认 worker 上限仍为 4，没有改超时或覆盖率门槛。
- 同一构建产物的 `group-http.mjs`、`employee-key-http.mjs`、`skills-upload-http.mjs` 三条 HTTP 回归全部退出 0。覆盖真实本地 PG/Redis 的组权限、三种协议及流式/工具往返、预算竞争/结算、设备归组、撤销与 401/403/429；上传回归另覆盖 Swagger YAML、ZIP 扫描/哈希及恶意 multipart 字段 400。推理使用模拟上游，不是生产付费模型验收。
- 官方生产依赖审计复查仍为 7 项（3 high / 4 moderate），上述风险判断和未接受状态不变。全量功能验证通过不等于安全审计清零。
- 13:06 本轮启动的测试 PG/Redis 已正常停止，两个本地端口不再监听，测试数据保留。没有生产访问/部署、合并 main、推送或创建正式发布包；本轮只更新验证记录。

## 前轮验证过程与限制（保留历史证据）

- `npm ci`、显式 `npm run db:generate`、类型检查、服务端构建、管理端构建、455 条依赖许可证检查通过。干净安装后首次 typecheck 因 Prisma 客户端尚未生成失败；生成后重跑通过，没有改动 schema。
- `node test/integration/skills-upload-http.mjs` 最终退出 0：Swagger YAML 导出 200、未认证 401、错误文件字段 400、恶意 multipart 字段 400、后续正常 ZIP 上传成功，扫描结果与哈希/保存字节一致。首次仅确认恶意请求不导致崩溃，审查后收紧断言为 400 并复现失败：NestJS 11 未映射 multer 新增错误码。现仅在技能上传拦截器补充 `LIMIT_FIELD_ARRAY_INDEX` / `INVALID_FIELD_NAME` → 400，其他错误继续原处理，保留原文件限额；类型检查、构建、HTTP 与技能定向回归再次通过。该脚本已接入既有 CI 的构建后 HTTP 回归步骤，远程 CI 尚未执行。
- 初次非数据库覆盖率运行（显式排除 `test/integration/**`）有 625 项通过、2 项跳过，Docker suite 在容器内 `npm ci` 因 ECONNRESET 失败，整体退出 1。未把这次部分通过称为完整 verify 通过。
- 排除 `data/` 后，Docker nginx 健康路由单项重试通过（退出 0，约 78 秒）；不更改安装命令、测试超时或断言。
- 随后整组非数据库覆盖率复跑为 99 文件、626 项通过、1 项依赖 PG 的迁移测试跳过，Docker 用例也通过。由于缺少数据库集成覆盖，行/语句 73.71%、函数 74.01% 未达既有门槛，命令仍退出 1；没有降低门槛，不记为完整验证通过。
- 补齐 multipart 400 映射和 CI 后，最终 `npm test -- --exclude 'test/integration/**'` 为 99 文件、626 项通过、1 项 PG 用例跳过，退出 0，Docker 健康路由仍通过。两项审查反馈（400 映射、CI 接入）修复后再次只读复核通过，未发现该小范围补丁新增问题；这不代替缺失的全量验证或剩余风险接受。
- 本地测试 PG `127.0.0.1:55439` 未运行，启动命令被执行策略拒绝，已请用户启动；不连接生产数据库替代测试，不重用上一轮的 655 项结果作为本轮证明。全量数据库、组预算及员工 Key HTTP 回归仍待复测。
- 正式发布、生产开关和真实付费模型调用均未执行；上一轮隔离演练镜像仍是修改前的 67f8151，不能用于交付本轮修复。

复测命令：

```powershell
npm ci
npm run db:generate
# 先由操作者配置并启动专用本地 TEST_DATABASE_URL / TEST_REDIS_URL
npm run verify
node --import tsx test/integration/group-http.mjs
node --import tsx test/integration/employee-key-http.mjs
node test/integration/skills-upload-http.mjs
npm audit --omit=dev --registry=https://registry.npmjs.org
```

运行存储回归还需要本地 Docker 及上述 MinIO 测试镜像；不会回退连接公司服务。最后一条当前应退出 0；如果未来出现告警，不能吞掉退出码。含开发依赖的 npm audit 仍有 4 项待另行处理。
