import { Transform } from 'node:stream'

// Gemini (generativelanguage) 协议适配：把 OpenAI Chat 请求/响应翻译成 Gemini generateContent 形式。

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') return (part as any).text || ''
      return ''
    }).join('')
  }
  return ''
}

export function toGeminiRequest(body: Record<string, any>): Record<string, any> {
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = []
  let systemInstruction: { parts: Array<{ text: string }> } | undefined
  for (const message of body.messages || []) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'system') {
      systemInstruction = { parts: [{ text: messageText(message.content) }] }
    } else {
      const role = message.role === 'assistant' ? 'model' : 'user'
      contents.push({ role, parts: [{ text: messageText(message.content) }] })
    }
  }
  const generationConfig: Record<string, any> = {}
  if (body.max_tokens != null) generationConfig.maxOutputTokens = body.max_tokens
  if (body.temperature != null) generationConfig.temperature = body.temperature
  if (body.top_p != null) generationConfig.topP = body.top_p
  const request: Record<string, any> = { contents }
  if (systemInstruction) request.systemInstruction = systemInstruction
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig
  return request
}

export function geminiUrl(baseUrl: string, model: string, stream: boolean): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const suffix = stream ? `v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse` : `v1beta/models/${encodeURIComponent(model)}:generateContent`
  return new URL(suffix, base).href
}

function usageToOpenAI(usage: any): Record<string, any> {
  return {
    prompt_tokens: usage?.promptTokenCount || 0,
    completion_tokens: usage?.candidatesTokenCount || 0,
    total_tokens: usage?.totalTokenCount || 0,
    prompt_tokens_details: { cached_tokens: usage?.cachedContentTokenCount || 0 },
    completion_tokens_details: { reasoning_tokens: usage?.thoughtsTokenCount || 0 }
  }
}

export function geminiResponseToOpenAI(payload: any, model: string): Record<string, any> {
  const candidate = payload?.candidates?.[0]
  const text = (candidate?.content?.parts || []).map((part: any) => part?.text || '').join('')
  return {
    id: 'chatcmpl-gemini',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: payload?.usageMetadata ? usageToOpenAI(payload.usageMetadata) : usageToOpenAI(null)
  }
}

// 把 Gemini SSE 流翻译成 OpenAI Chat SSE 流，并在结尾注入 usage 与 [DONE]。
export class GeminiStreamTranslator extends Transform {
  private buffer = ''
  private usage: any = null
  constructor(private readonly model: string) { super() }

  _transform(chunk: Buffer, _encoding: string, callback: (err?: Error | null, data?: Buffer) => void) {
    this.buffer += chunk.toString('utf8')
    const events = this.buffer.split(/\r?\n\r?\n/)
    this.buffer = events.pop() || ''
    for (const event of events) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('')
      if (!data || data === '[DONE]') continue
      try {
        const payload = JSON.parse(data)
        if (payload?.usageMetadata) this.usage = payload.usageMetadata
        const text = (payload?.candidates?.[0]?.content?.parts || []).map((part: any) => part?.text || '').join('')
        if (text) this.push(Buffer.from(`data: ${JSON.stringify(this.chunk(text))}\n\n`))
      } catch { /* 忽略非 JSON 事件 */ }
    }
    callback()
  }

  _flush(callback: (err?: Error | null, data?: Buffer) => void) {
    this.push(Buffer.from(`data: ${JSON.stringify({ choices: [], usage: usageToOpenAI(this.usage) })}\n\n`))
    this.push(Buffer.from('data: [DONE]\n\n'))
    callback()
  }

  private chunk(text: string): Record<string, any> {
    return { id: 'chatcmpl-gemini', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: this.model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }
  }
}
