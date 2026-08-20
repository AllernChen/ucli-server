# 供应商 / 渠道接入指南

网关通过「渠道（Channel）+ 渠道模型（ChannelModel）」接入上游模型。渠道保存连接、Key 选择和成本时区；渠道模型保存公共模型映射、上游模型名、协议能力、模型级健康状态和分时采购成本。渠道的 `protocol` 决定鉴权与端点约定：

| protocol | 鉴权 | 端点约定 |
| --- | --- | --- |
| `OPENAI` | `Authorization: Bearer <key>` | `{baseUrl}/v1/chat/completions`、`/v1/responses`、`/v1/models` |
| `ANTHROPIC` | `x-api-key: <key>` + `anthropic-version` | `{baseUrl}/v1/messages` |
| `GEMINI` | `x-goog-api-key: <key>` | `{baseUrl}/v1beta/models/{model}:generateContent` |

`baseUrl` 可包含路径（例如自建代理挂在 `/gateway` 下）；网关会保留该路径再拼接端点。

## 通用 OpenAI 兼容

`protocol=OPENAI` 即可接入任意 **OpenAI 兼容端点**（接受 `Authorization: Bearer` 且暴露 `/v1/chat/completions`）：

| 供应商 | protocol | baseUrl |
| --- | --- | --- |
| OpenAI | OPENAI | `https://api.openai.com` |
| Anthropic | ANTHROPIC | `https://api.anthropic.com` |
| DeepSeek | OPENAI | `https://api.deepseek.com` |
| Moonshot (Kimi) | OPENAI | `https://api.moonshot.cn` |
| vLLM（本地） | OPENAI | `http://localhost:8000` |
| Ollama（本地） | OPENAI | `http://localhost:11434` |

## Gemini

Gemini 通过**原生 `generateContent` 协议**接入：渠道 `protocol=GEMINI`、`baseUrl=https://generativelanguage.googleapis.com`，渠道模型 `protocol=GEMINI`。网关会把 OpenAI Chat 请求翻译成 `generateContent`（`contents`/`systemInstruction`），并把响应（含流式 SSE）翻译回 OpenAI Chat 格式。当前覆盖文本对话；工具调用与多模态暂未支持。

## 渠道模型健康测试

渠道模型探测固定发送 `Reply OK.`，只记录 HTTP 状态、延迟、Token、Key 后四位和错误码，不保存请求或响应正文。401/403 会立即标记模型不可用；429、5xx 和超时按连续失败次数从降级转为不可用。管理后台支持单模型测试、单渠道最多 20 个模型的批量测试，以及固定渠道模型的多轮对话测试台。

## 分时采购成本

每个渠道模型可配置基础成本和峰时覆盖规则，字段包括适用星期、起止分钟、优先级、生效区间，以及输入、输出、缓存、推理四类 Token 的美元/百万 Token 采购单价。规则按渠道的 IANA 时区解析；跨午夜规则的星期表示窗口开始日。

网关在请求开始时解析每个候选渠道模型的成本，用候选中每类 Token 的最高单价做公司内部预算预留，成功后按实际命中的渠道模型和实际 Token 结算。每条用量会固化 `channelModelId`、`channelCostRuleId` 和 `costSnapshot`，历史统计不受后续调价影响。公共模型的 `ModelPriceVersion` 只作为尚未配置渠道成本时的兼容兜底。

这些金额全部代表公司统一采购渠道的成本；平台不维护员工销售价，不计算收入、回款、毛利或利润率。
