import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function dockerBuildEnvironment(workflow: string) {
  const lines = workflow.split(/\r?\n/)
  const jobStart = lines.findIndex(line => line === '  docker-build:')
  const jobEnd = lines.findIndex((line, index) => index > jobStart && /^  \S/.test(line))
  const jobLines = lines.slice(jobStart, jobEnd === -1 ? undefined : jobEnd)
  const environmentStart = jobLines.findIndex(line => line === '        env:')
  const environment: Record<string, string> = {}

  for (const line of jobLines.slice(environmentStart + 1)) {
    const match = line.match(/^          ([A-Z][A-Z0-9_]*):\s*(.+)$/)
    if (!match) break
    environment[match[1]] = match[2]
  }

  return environment
}

describe('CI Docker Compose configuration', () => {
  it('renders with the environment declared by the docker-build job', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    const ciEnvironment = dockerBuildEnvironment(workflow)
    const result = spawnSync('docker', ['compose', 'config', '--quiet'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PUBLIC_URL: '', ...ciEnvironment }
    })

    expect(result.status, result.stderr || result.stdout).toBe(0)
  }, 30_000)
})
