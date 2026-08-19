# 供应商 / 渠道接入指南

网关通过「渠道（Channel）+ 能力（Ability）」接入上游模型。渠道的 `protocol` 决定鉴权与端点约定：

| protocol | 鉴权 | 端点约定 |
| --- | --- | --- |
| `OPENAI` | `Authorization: Bearer <key>` | `{baseUrl}/v1/chat/completions`、`/v1/responses`、`/v1/models` |
| `ANTHROPIC` | `x-api-key: <key>` + `anthropic-version` | `{baseUrl}/v1/messages` |

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

Google Gemini 的**原生 `generateContent` 协议**（`contents`/`systemInstruction` 结构）需要请求/响应翻译层，当前尚未实现。接入 Gemini 建议作为独立特性推进：涉及 `ChannelProtocol`/`GatewayProtocol` 枚举迁移，以及 OpenAI Chat → Gemini `generateContent` 的请求与响应（含流式）翻译。
