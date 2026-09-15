// Run after npm run build. Real HTTP/Nest/ZIP/MinIO path; in-memory DB, disposable loopback-only storage.
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buffer as readBuffer } from 'node:stream/consumers'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import AdmZip from 'adm-zip'
import { SkillsController } from '../../dist/apps/api/src/skills.controller.js'
import { PrismaService } from '../../dist/packages/database/src/prisma.service.js'
import { ObjectStorageService } from '../../dist/packages/storage/src/object-storage.js'
import { AuthGuard, signAccessToken } from '../../dist/packages/security/src/auth.js'

process.env.JWT_SECRET = randomUUID()
const accountId = randomUUID(), organizationId = randomUUID(), skillId = randomUUID()
const versions = []
const docker = promisify(execFile)
const container = `ucli-skills-http-${randomUUID()}`
const storageSecret = randomUUID()
class UploadTestModule {}
Module({
  controllers: [SkillsController],
  providers: [AuthGuard,
    { provide: PrismaService, useValue: {
      account: { findUnique: async () => ({ id: accountId, status: 'ACTIVE', tokenVersion: 1,
        memberships: [{ role: 'PLATFORM_ADMIN', status: 'ACTIVE', organization: { enabled: true } }] }) },
      skillVersion: {
        create: async ({ data }) => { const version = { id: randomUUID(), ...data }; versions.push(version); return version },
        findFirst: async ({ where }) => versions.find(version => version.id === where.id && version.status === where.status) || null
      }
    } },
    ObjectStorageService
  ]
})(UploadTestModule)
let app
try {
  await docker('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::9000',
    '-e', 'MINIO_ROOT_USER=ucli-test', '-e', `MINIO_ROOT_PASSWORD=${storageSecret}`,
    'quay.io/minio/minio:RELEASE.2025-07-23T15-54-02Z', 'server', '/data'], { timeout: 180_000 })
  const { stdout } = await docker('docker', ['port', container, '9000/tcp'])
  const storagePort = stdout.trim().split(':').at(-1)
  Object.assign(process.env, { MINIO_ENDPOINT: '127.0.0.1', MINIO_PORT: storagePort, MINIO_USE_SSL: 'false',
    MINIO_ACCESS_KEY: 'ucli-test', MINIO_SECRET_KEY: storageSecret, MINIO_SKILLS_BUCKET: 'ucli-skills-http' })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`http://127.0.0.1:${storagePort}/minio/health/ready`, { signal: AbortSignal.timeout(1000) })).ok } catch { /* server starting */ }
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(ready, true)
  app = await NestFactory.create(UploadTestModule, { logger: false })
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Upload test').setVersion('1').build()))
  await app.listen(0, '127.0.0.1')
  const base = await app.getUrl()
  const schema = await fetch(`${base}/api/docs-yaml`, { signal: AbortSignal.timeout(10000) })
  assert.equal(schema.status, 200)
  assert.match(await schema.text(), /openapi: 3\.0\.0/)
  const token = signAccessToken({ sub: accountId, organizationId, role: 'PLATFORM_ADMIN', tokenVersion: 1 })
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from('---\nname: upload-probe\ndescription: Local upload regression\n---\nUse safely'))
  const buffer = zip.toBuffer()
  const upload = async (form, authorized = true) => fetch(`${base}/api/v1/skills/admin/${skillId}/versions`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(10000),
    headers: authorized ? { Authorization: `Bearer ${token}` } : {}
  })
  const form = (field = 'file') => {
    const body = new FormData()
    body.set('version', '1.0.0')
    body.set(field, new Blob([buffer], { type: 'application/zip' }), 'skill.zip')
    return body
  }
  assert.equal((await upload(form(), false)).status, 401)
  assert.equal((await upload(form('wrong-file'))).status, 400)
  // The upstream crash regression must be rejected and leave the server able to accept the next upload.
  const malformed = new FormData()
  malformed.set('items[4294967294]', 'x')
  malformed.set('items[]', 'y')
  const rejected = await upload(malformed)
  assert.equal(rejected.status, 400)
  assert.equal(versions.length, 0)
  const response = await upload(form())
  assert.equal(response.status, 201)
  const version = await response.json()
  assert.equal(version.sha256, createHash('sha256').update(buffer).digest('hex'))
  assert.equal(version.scanResult.safe, true)
  assert.equal(version.manifest.name, 'upload-probe')
  assert.deepEqual(await readBuffer(await app.get(ObjectStorageService).get(version.objectKey)), buffer)
  assert.equal(versions.length, 1)
  const download = () => fetch(`${base}/api/v1/skills/${version.id}/download`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000)
  })
  assert.equal((await download()).status, 404)
  versions[0].status = 'PUBLISHED'
  const downloaded = await download()
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get('content-type'), 'application/zip')
  assert.equal(downloaded.headers.get('x-ucli-sha256'), version.sha256)
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), buffer)
  console.log(`Skills storage HTTP passed: Swagger YAML, auth, crafted fields (${rejected.status}), real MinIO ZIP upload/download/hash, unpublished 404.`)
} finally {
  try { await app?.close() } finally { await docker('docker', ['rm', '-f', '-v', container], { timeout: 30_000 }) }
}
