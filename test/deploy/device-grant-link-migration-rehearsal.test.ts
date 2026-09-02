import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const rehearsal = readFileSync('scripts/rehearse-device-grant-link-migration.ps1', 'utf8')

describe('device grant link migration rehearsal', () => {
  it('removes containers only by immutable IDs captured by this invocation', () => {
    const staleCleanup = rehearsal.slice(rehearsal.indexOf('  $existing ='), rehearsal.indexOf('  $startedContainerId ='))
    const cleanup = rehearsal.slice(rehearsal.lastIndexOf('finally {'))

    expect(staleCleanup).toContain("docker inspect --format '{{.State.Running}}' $existing")
    expect(staleCleanup).toContain("Invoke-Docker @('rm', $existing)")
    expect(cleanup).toContain('& docker rm -f $startedContainerId')
    expect(cleanup).not.toContain('$Container')
    expect(rehearsal).not.toMatch(/(?:docker rm -f|Invoke-Docker @\('rm',)\s+\$Container/)
  })
})
