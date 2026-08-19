import { describe, expect, it } from 'vitest'
import { geminiResponseToOpenAI, geminiUrl, GeminiStreamTranslator, toGeminiRequest } from '../../packages/gateway-core/src/gemini.js'

describe('gemini protocol adapter', () => {
  it('translates OpenAI messages to Gemini contents and systemInstruction', () => {
    const request = toGeminiRequest({ messages: [
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ], max_tokens: 100 })
    expect(request.systemInstruction).toEqual({ parts: [{ text: 'Be concise' }] })
    expect(request.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] }
    ])
    expect(request.generationConfig.maxOutputTokens).toBe(100)
  })

  it('builds generateContent URLs', () => {
    expect(geminiUrl('https://generativelanguage.googleapis.com', 'gemini-2.0-flash', false))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent')
    expect(geminiUrl('https://generativelanguage.googleapis.com', 'gemini-2.0-flash', true))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse')
  })

  it('translates a Gemini response to an OpenAI chat completion', () => {
    const openai = geminiResponseToOpenAI({
      candidates: [{ content: { parts: [{ text: 'answer' }], role: 'model' } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 }
    }, 'gemini-2.0-flash')
    expect(openai.choices[0].message.content).toBe('answer')
    expect(openai.usage.prompt_tokens).toBe(10)
    expect(openai.usage.completion_tokens).toBe(4)
  })

  it('translates Gemini SSE chunks to OpenAI chat SSE with final usage', async () => {
    const translator = new GeminiStreamTranslator('gemini-2.0-flash')
    const chunks: string[] = []
    translator.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
    const done = new Promise<void>(resolve => translator.on('end', resolve))
    translator.write(Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n'))
    translator.write(Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n'))
    translator.end()
    await done
    const joined = chunks.join('')
    expect(joined).toContain('"content":"Hello"')
    expect(joined).toContain('"usage"')
    expect(joined).toContain('[DONE]')
  })
})
