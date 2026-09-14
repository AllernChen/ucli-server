import { BadRequestException } from '@nestjs/common'
import Decimal from 'decimal.js'
import type { GatewayProtocol } from '../../gateway-core/src/protocol.js'
import type { PriceSnapshot } from '../../gateway-core/src/cost.js'

export function cny(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/.test(value)) {
    throw new BadRequestException('CNY amount must be a nonnegative decimal string with at most 12 integer and 8 fractional digits')
  }
  return new Decimal(value).toFixed(8)
}

export function availableCny(limit: string, spent: string, reserved: string): string {
  return new Decimal(limit).minus(spent).minus(reserved).toFixed(8)
}

export function budgetPeriodKey(mode: 'TOTAL' | 'MONTHLY', timezone: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(at)
    return mode === 'TOTAL' ? 'TOTAL' : `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}`
  } catch { throw new BadRequestException('Invalid budget timezone or date') }
}

export function prepareBudgetRequest(protocol: GatewayProtocol, input: Record<string, any>, contextSize: number) {
  const invalid = () => new BadRequestException({ code: 'invalid_budget_request', message: 'Invalid input or output token limit' })
  const unsupported = () => new BadRequestException({ code: 'unsupported_budget_estimation', message: 'This input cannot be reliably estimated for a group budget' })
  const body = { ...input }
  const content = protocol === 'openai_responses' ? body.input : body.messages
  if (!content || (!Array.isArray(content) && typeof content !== 'string') || !content.length || !Number.isSafeInteger(contextSize) || contextSize <= 0) throw invalid()
  if (protocol !== 'openai_responses' && (!Array.isArray(content) || content.some(message => !message || typeof message !== 'object' ||
    !['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(message.role)))) throw invalid()
  if ((body.tools !== undefined && !Array.isArray(body.tools)) || (body.modalities !== undefined && !Array.isArray(body.modalities))) throw invalid()
  // Only text and caller-supplied function tools have prices in the current procurement model.
  const textOnly = (value: any): boolean => {
    if (value == null || typeof value !== 'object') return true
    if (Array.isArray(value)) return value.every(textOnly)
    if (value.type && !['text', 'input_text', 'output_text', 'message', 'tool_use', 'tool_result', 'function_call', 'function_call_output', 'thinking', 'redacted_thinking'].includes(value.type)) return false
    return Object.entries(value).every(([key, child]) => !['image_url', 'audio', 'file_id', 'cache_control', 'attachments'].includes(key) && (['input', 'arguments'].includes(key) ? true : textOnly(child)))
  }
  if (!textOnly(content) || !textOnly(body.system) || body.previous_response_id || body.conversation || body.audio || body.modalities?.some((v: string) => v !== 'text') ||
    (body.n !== undefined && body.n !== 1) || body.best_of !== undefined || body.tools?.some((tool: any) => !tool || tool.cache_control || (tool.type && tool.type !== 'function'))) throw unsupported()
  const capFields = ['max_tokens', 'max_completion_tokens', 'max_output_tokens']
  const provided = capFields.filter(field => body[field] !== undefined)
  if (provided.some(field => !Number.isSafeInteger(body[field]) || body[field] <= 0) || new Set(provided.map(field => body[field])).size > 1) throw invalid()
  const field = protocol === 'openai_responses' ? 'max_output_tokens' : protocol === 'openai_chat' && body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens'
  if (provided.some(key => protocol === 'openai_chat' ? key === 'max_output_tokens' : key !== field)) throw invalid()
  // UTF-8 bytes plus envelope overhead bound ordinary text; no /4 heuristic for reservations.
  const inputTokens = Buffer.byteLength(JSON.stringify(body), 'utf8') + 256
  const outputTokens = provided.length ? body[provided[0]] as number : Math.min(4096, contextSize - inputTokens)
  if (outputTokens <= 0 || inputTokens + outputTokens > contextSize) throw invalid()
  for (const key of capFields) delete body[key]
  body[field] = outputTokens
  return { body, inputTokens, outputTokens }
}

export function estimateBudgetCost(inputTokens: number, outputTokens: number, prices: PriceSnapshot[]): string {
  if (!prices.length) throw new BadRequestException('Procurement cost is required')
  const cost = Decimal.max(...prices.map(price => new Decimal(inputTokens).times(Decimal.max(price.inputPerMillion, price.cachedPerMillion))
    .plus(new Decimal(outputTokens).times(Decimal.max(price.outputPerMillion, price.reasoningPerMillion))).div(1_000_000)))
  return cny(cost.toFixed(8, Decimal.ROUND_CEIL))
}
