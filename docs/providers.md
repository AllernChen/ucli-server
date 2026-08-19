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

Gemini 通过**原生 `generateContent` 协议**接入：渠道 `protocol=GEMINI`、`baseUrl=https://generativelanguage.googleapis.com`，模型能力 `protocol=GEMINI`。网关会把 OpenAI Chat 请求翻译成 `generateContent`（`contents`/`systemInstruction`），并把响应（含流式 SSE）翻译回 OpenAI Chat 格式。当前覆盖文本对话；工具调用与多模态暂未支持。
