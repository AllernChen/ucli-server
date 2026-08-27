import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const rehearsal = readFileSync('scripts/rehearse-device-grant-link-migration.ps1', 'utf8')

describe('device grant link migration rehearsal', () => {
  it('removes only the immutable container ID recorded by this invocation', () => {
    const cleanup = rehearsal.slice(rehearsal.lastIndexOf('finally {'))

    expect(cleanup).toContain('& docker rm -f $startedContainerId')
    expect(cleanup).not.toContain('$Container')
  })
})
