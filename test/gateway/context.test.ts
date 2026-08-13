import { describe, expect, it } from 'vitest'
import { parseUcliContext } from '../../packages/gateway-core/src/ucli-context.js'

describe('UCLI request context', () => {
  it('accepts anonymous UUID labels and known CLI types', () => {
    const value = parseUcliContext({
      'x-ucli-session-id': 'd9428888-122b-11e1-b85c-61cd3cbb3210',
      'x-ucli-project-id': 'a8098c1a-f86e-11da-bd1a-00112444be1e',
      'x-ucli-cli-type': 'codex',
      'x-ucli-client-version': '0.10.2',
      'x-ucli-timezone': 'Asia/Shanghai'
    })
    expect(value.cliType).toBe('codex')
    expect(value.timezone).toBe('Asia/Shanghai')
  })

  it('rejects paths and unknown CLI types', () => {
    expect(() => parseUcliContext({ 'x-ucli-project-id': 'C:\\secret\\repo' })).toThrow()
    expect(() => parseUcliContext({ 'x-ucli-cli-type': 'other' })).toThrow()
  })
})
