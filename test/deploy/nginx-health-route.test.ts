import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

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

async function docker(args: string[]) {
  const { stdout } = await execFileAsync('docker', args, { encoding: 'utf8', timeout: 180_000 })
  return stdout.trim()
}

describe.skipIf(!hasDocker)('deployed nginx health route', () => {
  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'ucli-nginx-health-'))
    chmodSync(temporaryDirectory, 0o755)
    writeFileSync(join(temporaryDirectory, 'healthz'), '{"status":"ok","source":"api"}')
    writeFileSync(join(temporaryDirectory, 'api.conf'), 'server { listen 3000; root /usr/share/nginx/html; }\n')
    writeFileSync(join(temporaryDirectory, 'gateway.conf'), 'server { listen 3001; root /usr/share/nginx/html; }\n')

    await docker(['network', 'create', network])
    await docker(['run', '-d', '--name', apiContainer, '--network', network, '--network-alias', 'api',
      '-v', `${temporaryDirectory}:/usr/share/nginx/html:ro`, '-v', `${join(temporaryDirectory, 'api.conf')}:/etc/nginx/conf.d/default.conf:ro`,
      'nginx:1.27-alpine'])
    await docker(['run', '-d', '--name', gatewayContainer, '--network', network, '--network-alias', 'gateway',
      '-v', `${temporaryDirectory}:/usr/share/nginx/html:ro`, '-v', `${join(temporaryDirectory, 'gateway.conf')}:/etc/nginx/conf.d/default.conf:ro`,
      'nginx:1.27-alpine'])
    await docker(['build', '--target', 'admin', '-t', image, resolve('.')])
    await docker(['run', '-d', '--name', webContainer, '--network', network, '-p', '127.0.0.1::80', image])
  }, 180_000)

  afterAll(async () => {
    for (const container of [webContainer, apiContainer, gatewayContainer]) {
      try { await docker(['rm', '-f', container]) } catch { /* best-effort test cleanup */ }
    }
    try { await docker(['network', 'rm', network]) } catch { /* best-effort test cleanup */ }
    try { await docker(['image', 'rm', '-f', image]) } catch { /* best-effort test cleanup */ }
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  it('proxies external /healthz to the API instead of returning the SPA shell', async () => {
    const portOutput = await docker(['port', webContainer, '80/tcp'])
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
