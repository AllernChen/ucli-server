import 'reflect-metadata'
import { execFile } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { buffer } from 'node:stream/consumers'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ObjectStorageService } from '../../packages/storage/src/object-storage.js'

const exec = promisify(execFile)
const image = 'quay.io/minio/minio:RELEASE.2025-07-23T15-54-02Z'
// A disposable server, random credentials and loopback-only port; never use a configured company endpoint.
describe.each(['us-east-1', 'cn-test-1'])('object storage against MinIO (%s)', region => {
  const container = `ucli-storage-test-${randomUUID()}`
  const secret = randomUUID()
  const clients: ObjectStorageService[] = []
  let port: string
  const storage = () => { const client = new ObjectStorageService(); clients.push(client); return client }
  beforeAll(async () => {
    await exec('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::9000',
      '-e', 'MINIO_ROOT_USER=ucli-test', '-e', `MINIO_ROOT_PASSWORD=${secret}`,
      '-e', `MINIO_REGION_NAME=${region}`, image, 'server', '/data'], { timeout: 180_000 })
    const mapping = await exec('docker', ['port', container, '9000/tcp'])
    port = mapping.stdout.trim().split(':').at(-1)!
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/minio/health/ready`, { signal: AbortSignal.timeout(1000) })).ok } catch { /* server starting */ }
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(ready).toBe(true)
  }, 180_000)
  afterEach(() => {
    for (const client of clients.splice(0)) client.onModuleDestroy()
    vi.unstubAllEnvs()
  })
  afterAll(async () => {
    await exec('docker', ['rm', '-f', '-v', container], { timeout: 30_000 })
  })
  const configure = () => {
    vi.stubEnv('MINIO_ENDPOINT', '127.0.0.1')
    vi.stubEnv('MINIO_PORT', port)
    vi.stubEnv('MINIO_USE_SSL', 'false')
    vi.stubEnv('MINIO_ACCESS_KEY', 'ucli-test')
    vi.stubEnv('MINIO_SECRET_KEY', secret)
    vi.stubEnv('MINIO_SKILLS_BUCKET', `skills-${randomUUID()}`)
  }
  it('creates the bucket and preserves ZIP bytes, keys and streaming downloads across client instances', async () => {
    configure()
    const original = storage()
    const bytes = Buffer.alloc(20 * 1024 * 1024, 0x5a)
    const key = 'skills/id/中文 + %?#/archive.zip'
    await original.put(key, bytes)
    const stream = await storage().get(key)
    expect(typeof stream.pipe).toBe('function')
    const downloaded = await buffer(stream)
    expect(downloaded.length).toBe(bytes.length)
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
  }, 30_000)
  it('supports simultaneous first uploads without losing either object', async () => {
    configure()
    const client = storage()
    await Promise.all([client.put('first.zip', Buffer.from('first')), client.put('second.zip', Buffer.from('second'))])
    expect((await buffer(await client.get('first.zip'))).toString()).toBe('first')
    expect((await buffer(await client.get('second.zip'))).toString()).toBe('second')
  }, 15_000)
  it('propagates missing objects and rejected credentials instead of returning empty downloads', async () => {
    configure()
    const client = storage()
    await client.put('exists.zip', Buffer.from('keep'))
    await expect(client.get('missing.zip')).rejects.toBeInstanceOf(Error)
    vi.stubEnv('MINIO_SECRET_KEY', 'incorrect-secret-for-test')
    await expect(storage().put('blocked.zip', Buffer.from('no'))).rejects.toBeInstanceOf(Error)
    expect((await buffer(await client.get('exists.zip'))).toString()).toBe('keep')
    await expect(client.get('blocked.zip')).rejects.toBeInstanceOf(Error)
  }, 15_000)
})
