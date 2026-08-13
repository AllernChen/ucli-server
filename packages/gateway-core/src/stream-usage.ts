import type { GatewayProtocol, NormalizedUsage } from './protocol.js'
import { normalizeUsage } from './protocol.js'

export class StreamUsageCollector {
  private buffer = ''
  private receivedBytes = 0
  private collected: NormalizedUsage = normalizeUsage(undefined)
  constructor(private readonly protocol: GatewayProtocol) {}

  push(chunk: Buffer): void {
    this.receivedBytes += chunk.byteLength
    this.buffer += chunk.toString('utf8')
    const events = this.buffer.split(/\r?\n\r?\n/)
    this.buffer = events.pop() || ''
    for (const event of events) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('')
      if (!data || data === '[DONE]') continue
      try {
        const payload = JSON.parse(data)
        const candidate = this.protocol === 'anthropic_messages'
          ? payload.message?.usage ?? payload.usage
          : this.protocol === 'openai_responses'
            ? payload.response?.usage ?? payload.usage
            : payload.usage
        if (!candidate) continue
        const usage = normalizeUsage(candidate)
        this.collected = {
          inputTokens: Math.max(this.collected.inputTokens, usage.inputTokens),
          outputTokens: Math.max(this.collected.outputTokens, usage.outputTokens),
          cachedTokens: Math.max(this.collected.cachedTokens, usage.cachedTokens),
          reasoningTokens: Math.max(this.collected.reasoningTokens, usage.reasoningTokens),
          source: 'upstream'
        }
      } catch { /* Ignore non-JSON upstream event metadata. */ }
    }
  }

  usage(estimatedInputTokens = 1): NormalizedUsage {
    if (this.collected.source === 'upstream') return { ...this.collected }
    return {
      inputTokens: Math.max(1, estimatedInputTokens),
      outputTokens: Math.max(1, Math.ceil(this.receivedBytes / 4)),
      cachedTokens: 0,
      reasoningTokens: 0,
      source: 'estimated'
    }
  }
}
