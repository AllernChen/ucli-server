import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const protocol = readFileSync('docs/ucli-client-protocol.md', 'utf8')
const clientUpgrade = readFileSync('docs/ucli-client-registration-upgrade.md', 'utf8')
const design = readFileSync('docs/superpowers/specs/2026-08-26-device-grant-registration-design.md', 'utf8')
const plan = readFileSync('docs/superpowers/plans/2026-08-26-device-grant-registration.md', 'utf8')
const readme = readFileSync('README.md', 'utf8')
const deploy = readFileSync('DEPLOY.md', 'utf8')
const changelog = readFileSync('CHANGELOG.md', 'utf8')
const migration = readFileSync('prisma/migrations/202608260001_device_grants/migration.sql', 'utf8')
const schema = readFileSync('prisma/schema.prisma', 'utf8')

function jsonBlock(heading: string): unknown {
  const start = protocol.indexOf(`### ${heading}\n\n\`\`\`json\n`)
  expect(start, `Missing JSON contract: ${heading}`).toBeGreaterThanOrEqual(0)
  const bodyStart = start + `### ${heading}\n\n\`\`\`json\n`.length
  const end = protocol.indexOf('\n```', bodyStart)
  expect(end, `Unclosed JSON contract: ${heading}`).toBeGreaterThan(bodyStart)
  return JSON.parse(protocol.slice(bodyStart, end))
}

function fencedBlock(source: string, heading: string, language: string): string {
  const marker = `### ${heading}\n\n\`\`\`${language}\n`
  const start = source.indexOf(marker)
  expect(start, `Missing ${language} contract: ${heading}`).toBeGreaterThanOrEqual(0)
  const bodyStart = start + marker.length
  const end = source.indexOf('\n```', bodyStart)
  expect(end, `Unclosed ${language} contract: ${heading}`).toBeGreaterThan(bodyStart)
  return source.slice(bodyStart, end)
}

function sqlWithoutComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim()
}

describe('device grant release contract', () => {
  it('uses the exact fragment browser link and registration routes without a legacy device-code fallback', () => {
    expect(protocol).toContain('http://10.0.0.8:3000/connect#token=one-time-secret')
    expect(protocol).toContain('ucli://connect?server=http%3A%2F%2F10.0.0.8%3A3000#token=<secret>')
    expect(protocol).not.toContain('connect?token=')
    expect(fencedBlock(protocol, 'Preview HTTP', 'http')).toBe('POST /api/v1/auth/device-grants/preview\nContent-Type: application/json')
    expect(fencedBlock(protocol, 'Redeem HTTP', 'http')).toBe('POST /api/v1/auth/device-grants/redeem\nContent-Type: application/json')
    expect(fencedBlock(protocol, 'Refresh HTTP', 'http')).toBe('POST /api/v1/auth/token/refresh\nContent-Type: application/json')
    expect(fencedBlock(protocol, 'Bootstrap HTTP', 'http')).toBe('GET /api/v1/client/bootstrap\nAuthorization: Bearer <accessToken>')
    expect(protocol).not.toMatch(/(?:GET|POST) \/api\/v1\/auth\/device\/(?:code|token|approve)/)
    expect(protocol).not.toContain('/api/v1/auth/invitations/accept')
  })

  it('publishes parseable preview, redeem, refresh, and bootstrap JSON contracts', () => {
    expect(jsonBlock('创建响应')).toEqual({
      id: 'grant-uuid', connectionUrl: 'http://10.0.0.8:3000/connect#token=one-time-secret', expiresAt: null
    })
    expect(jsonBlock('Preview 请求')).toEqual({ token: '<secret>' })
    expect(jsonBlock('Preview 响应')).toEqual({
      account: { id: 'account-uuid', displayName: '成员姓名' },
      organization: { id: 'organization-uuid', name: '组织名称' },
      status: 'AVAILABLE',
      authorization: { expiresAt: null, serverTime: '2026-08-26T04:00:00.000Z' }
    })
    expect(jsonBlock('Redeem 请求')).toEqual({
      token: '<secret>',
      device: { installationId: '550e8400-e29b-41d4-a716-446655440000', name: '张三的工作站', platform: 'windows', clientVersion: '1.2.0' }
    })
    expect(jsonBlock('Redeem 响应')).toEqual({
      accessToken: 'jwt', refreshToken: 'opaque-refresh-token', expiresIn: 900,
      account: { id: 'account-uuid', displayName: '成员姓名' },
      organization: { id: 'organization-uuid', name: '组织名称' },
      authorization: { expiresAt: null, serverTime: '2026-08-26T04:00:00.000Z' }
    })
    expect(jsonBlock('Refresh 请求')).toEqual({ refreshToken: 'opaque-refresh-token' })
    expect(jsonBlock('Refresh 响应')).toEqual({
      accessToken: 'jwt', refreshToken: 'next-opaque-refresh-token', expiresIn: 900,
      authorization: { expiresAt: null, serverTime: '2026-08-26T04:00:00.000Z' }
    })
    expect(jsonBlock('Bootstrap 响应')).toEqual({
      organization: { id: 'organization-uuid', name: '组织名称', timezone: 'Asia/Shanghai' },
      gateway: { baseUrl: 'http://10.0.0.8:3001' },
      models: [{ id: 'example-model', displayName: '示例模型', contextSize: 128000 }],
      skillsCatalogUrl: 'http://10.0.0.8:3000/api/v1/skills/catalog',
      authorization: { expiresAt: null, serverTime: '2026-08-26T04:00:00.000Z' }
    })
  })

  it('defines exact device validation, preview states, server response cache policy, and stable failures', () => {
    expect(protocol).toMatch(/`installationId`[^。]*UUID v4/)
    expect(protocol).toMatch(/`name`[^。]*1–120/)
    expect(protocol).toMatch(/`platform`[^。]*`windows`、`macos`、`linux`/)
    expect(protocol).toMatch(/`clientVersion`[^。]*1–32/)
    expect(protocol).toContain('服务端响应头 `Cache-Control: no-store`')
    expect(protocol).not.toMatch(/POST \/api\/v1\/auth\/device-grants\/(?:preview|redeem)\nContent-Type: application\/json\nCache-Control/)
    expect(design.replace(/\r\n/g, '\n')).not.toMatch(/POST \/api\/v1\/auth\/device-grants\/preview\nContent-Type: application\/json\nCache-Control: no-store/)
    expect(design).toContain('响应使用 `Cache-Control: no-store`')

    for (const status of ['AVAILABLE', 'BOUND', 'DISABLED', 'EXPIRED', 'DELETED']) expect(protocol).toContain(status)
    for (const code of [
      'invalid_grant', 'grant_disabled', 'grant_expired', 'grant_already_bound',
      'grant_deleted', 'account_inactive', 'organization_inactive', 'invalid_device'
    ]) expect(protocol).toContain(code)
  })

  it('keeps the client independently implementable and confines raw credential material', () => {
    for (const text of [
      '独立安装、独立使用', '只维护一个当前服务端连接', 'POST /api/v1/auth/device-grants/preview',
      'POST /api/v1/auth/device-grants/redeem', 'POST /api/v1/auth/token/refresh',
      'GET /api/v1/client/bootstrap', '操作系统安全存储', '联系管理员延期',
      'grant_disabled', '服务端模型', '本地模型', '确认页关闭', '注册失败', '切换用户', '卸载时清空'
    ]) expect(clientUpgrade).toContain(text)
    expect(clientUpgrade).not.toMatch(/\]\([^)]*\.md\)/)

    for (const text of [
      '管理端创建设备授权 API 的一次性 `connectionUrl` 响应', '绝不返回裸 `token` 字段', '对应的一次性 Vue 弹窗',
      '弹窗关闭', '创建失败', '切换用户', '卸载时清空', 'tokenHash`/`refreshTokenHash` 永不展示',
      'URL query', '日志、异常、审计、storage'
    ]) expect(protocol).toContain(text)
    expect(design).not.toContain('"token": "one-time-secret"')
    expect(plan).not.toContain('result.token')
    expect(plan).not.toContain('Return `token` and `connectionUrl`')
  })

  it('publishes managed-member, deployment, and destructive migration boundaries', () => {
    expect(readme).toContain('平台预创建普通成员')
    expect(readme).toContain('每台设备创建授权')
    expect(deploy).toContain('精确的 UCLI 可访问 origin')
    expect(deploy).toContain('http://IP[:port]')
    expect(deploy).toContain('可信公司内网')
    expect(deploy).toContain('staging rehearsal')
    expect(deploy).toContain('pg_depend')
    expect(deploy).toContain("'public.\"DeviceCodeStatus\"'::regtype::oid")
    expect(deploy).not.toContain("'public.DeviceCodeStatus'::regtype::oid")
    expect(deploy).toContain('pg_describe_object')
    expect(deploy).toContain('device_authorizations')
    expect(deploy).toContain('pg_attrdef')
    expect(deploy).toContain('预期严格 0 行')
    expect(deploy).toContain('任何行禁止升级')
    expect(deploy).toContain('事务整体回滚')
    expect(deploy).toContain('数据库备份和上一版应用镜像')
    expect(changelog).toContain('旧邀请、设备码和旧设备 refresh token 全部失效')
  })

  it('wraps the destructive migration atomically and drops the enum after its dependent table', () => {
    const statements = sqlWithoutComments(migration).split(';').map(statement => statement.trim()).filter(Boolean)
    const tableDrop = statements.indexOf('DROP TABLE "device_authorizations"')
    const enumDrop = statements.indexOf('DROP TYPE "DeviceCodeStatus"')

    expect(statements[0]).toBe('BEGIN')
    expect(statements.at(-1)).toBe('COMMIT')
    expect(statements.slice(1, 7)).toEqual([
      'UPDATE "devices" SET "revoked_at" = CURRENT_TIMESTAMP WHERE "revoked_at" IS NULL',
      'ALTER TABLE "invitations" DROP CONSTRAINT "invitations_organization_id_fkey"',
      'ALTER TABLE "invitations" DROP CONSTRAINT "invitations_invited_by_id_fkey"',
      'ALTER TABLE "device_authorizations" DROP CONSTRAINT "device_authorizations_account_id_fkey"',
      'DROP TABLE "invitations"',
      'DROP TABLE "device_authorizations"'
    ])
    expect(tableDrop).toBeGreaterThanOrEqual(0)
    expect(enumDrop).toBeGreaterThan(tableDrop)
    expect(statements[enumDrop + 1]).toBe('ALTER TABLE "accounts" ALTER COLUMN "password_hash" DROP NOT NULL')
    expect(migration).not.toContain('DROP TYPE "DeviceCodeStatus" CASCADE')
    expect(schema).not.toContain('enum DeviceCodeStatus')
  })
})
