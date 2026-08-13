# UCLI 桌面端接入协议 v1

## 登录

登录不是使用 UCLI 本地功能的前置条件。需要平台能力时：

1. `POST /api/v1/auth/device/code`，请求 `{ "deviceName": "Windows 工作站" }`。
2. 展示 `userCode` 并打开 `verificationUri`。
3. 用户网页登录后，页面调用 `POST /api/v1/auth/device/approve`。
4. 客户端按 `interval` 轮询 `POST /api/v1/auth/device/token`。
5. 将 `accessToken` 和 `refreshToken` 存入操作系统安全存储。

## 启动配置

`GET /api/v1/client/bootstrap` 返回组织、网关地址、公开模型和技能目录地址。客户端为 Codex 创建 Responses 托管档案，为 Claude Code 创建 Anthropic Bearer 托管档案；平台设备访问令牌作为网关凭据，供应商 Key 永不下发。

## 模型请求头

除 `Authorization` 外可选发送：

- `X-UCLI-Session-ID`：UUID。
- `X-UCLI-Project-ID`：匿名项目 UUID，不得发送项目路径或名称。
- `X-UCLI-CLI-Type`：`claude`、`codex`、`opencode`、`ucode`。
- `X-UCLI-Client-Version`：最多32字符。
- `X-UCLI-Timezone`：IANA时区。

网关返回 `X-UCLI-Request-ID`，用于问题排查。客户端不上传独立遥测、使用事件或总结。

## 模型接口

- `GET /gateway/v1/models`
- `POST /gateway/v1/responses`
- `POST /gateway/v1/chat/completions`
- `POST /gateway/anthropic/v1/messages`

流式响应开始后平台不会自动重放请求。平台不可达时，应仅暂停平台模型和技能同步，不影响本地会话和本地模型。

## 技能目录

`GET /api/v1/skills/catalog?cursor=<ISO时间>` 返回当前组织可见的不可变技能版本。客户端从对象下载地址获取 ZIP，验证 SHA-256 后，复用现有 UCLI 安装、冲突和漂移处理流程。`REVOKED` 版本禁止新下载，已安装内容由客户端显示风险提示但不自动删除。
