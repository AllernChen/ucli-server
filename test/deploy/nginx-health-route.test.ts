import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

function dockerAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

const hasDocker = dockerAvailable()
const suffix = `${process.pid}-${Date.now()}`
const network = `ucli-nginx-health-${suffix}`
const image = `ucli-nginx-health:${suffix}`
const apiContainer = `ucli-health-api-${suffix}`
const gatewayContainer = `ucli-health-gateway-${suffix}`
const webContainer = `ucli-health-web-${suffix}`
let temporaryDirectory = ''

function docker(args: string[]) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000 }).trim()
}

describe.skipIf(!hasDocker)('deployed nginx health route', () => {
  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'ucli-nginx-health-'))
    writeFileSync(join(temporaryDirectory, 'healthz'), '{"status":"ok","source":"api"}')
    writeFileSync(join(temporaryDirectory, 'api.conf'), 'server { listen 3000; root /usr/share/nginx/html; }\n')
    writeFileSync(join(temporaryDirectory, 'gateway.conf'), 'server { listen 3001; root /usr/share/nginx/html; }\n')

    docker(['network', 'create', network])
    docker(['run', '-d', '--name', apiContainer, '--network', network, '--network-alias', 'api',
      '-v', `${temporaryDirectory}:/usr/share/nginx/html:ro`, '-v', `${join(temporaryDirectory, 'api.conf')}:/etc/nginx/conf.d/default.conf:ro`,
      'nginx:1.27-alpine'])
    docker(['run', '-d', '--name', gatewayContainer, '--network', network, '--network-alias', 'gateway',
      '-v', `${temporaryDirectory}:/usr/share/nginx/html:ro`, '-v', `${join(temporaryDirectory, 'gateway.conf')}:/etc/nginx/conf.d/default.conf:ro`,
      'nginx:1.27-alpine'])
    docker(['build', '--target', 'admin', '-t', image, resolve('.')])
    docker(['run', '-d', '--name', webContainer, '--network', network, '-p', '127.0.0.1::80', image])
  }, 180_000)

  afterAll(() => {
    for (const container of [webContainer, apiContainer, gatewayContainer]) {
      try { docker(['rm', '-f', container]) } catch { /* best-effort test cleanup */ }
    }
    try { docker(['network', 'rm', network]) } catch { /* best-effort test cleanup */ }
    try { docker(['image', 'rm', '-f', image]) } catch { /* best-effort test cleanup */ }
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  it('proxies external /healthz to the API instead of returning the SPA shell', async () => {
    const portOutput = docker(['port', webContainer, '80/tcp'])
    const port = Number(portOutput.match(/:(\d+)$/)?.[1])
    expect(port).toBeGreaterThan(0)

    let response: Response | undefined
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/healthz`)
        if (response.ok) break
      } catch { /* wait for nginx startup */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }

    expect(response?.status).toBe(200)
    await expect(response?.json()).resolves.toEqual({ status: 'ok', source: 'api' })
  })
})
