import { describe, expect, it } from 'vitest'
import * as apiModule from '../../apps/admin/src/api.js'

describe('model test request messages', () => {
  it('keeps the submitted message snapshot unchanged when a streaming placeholder is appended', () => {
    const snapshotMessages = (apiModule as Record<string, unknown>).snapshotModelTestMessages
    expect(snapshotMessages).toBeTypeOf('function')

    type Message = { role: 'system' | 'user' | 'assistant'; content: string }
    const messages: Message[] = [
      { role: 'system' as const, content: 'Be concise.' },
      { role: 'user' as const, content: 'Hello' }
    ]
    const submitted = (snapshotMessages as (value: Message[]) => Message[])(messages)

    messages.push({ role: 'assistant' as const, content: '' })

    expect(submitted).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' }
    ])
  })
})
