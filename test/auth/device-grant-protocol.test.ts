import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function readText(path: string) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

const protocol = readText('docs/ucli-client-protocol.md')
const clientUpgrade = readText('docs/ucli-client-registration-upgrade.md')
const modelProtocolUpgrade = readText('docs/ucli-client-model-protocol-upgrade.md')
const design = readText('docs/superpowers/specs/2026-08-26-device-grant-registration-design.md')
const plan = readText('docs/superpowers/plans/2026-08-26-device-grant-registration.md')
const readme = readText('README.md')
const deploy = readText('DEPLOY.md')
const changelog = readText('CHANGELOG.md')
const migration = readText('prisma/migrations/202608260001_device_grants/migration.sql')
const schema = readText('prisma/schema.prisma')

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

function sectionFencedBlock(source: string, heading: string, language: string): string {
  const marker = `## ${heading}\n\n\`\`\`${language}\n`
  const start = source.indexOf(marker)
  expect(start, `Missing ${language} section contract: ${heading}`).toBeGreaterThanOrEqual(0)
  const bodyStart = start + marker.length
  const end = source.indexOf('\n```', bodyStart)
  expect(end, `Unclosed ${language} section contract: ${heading}`).toBeGreaterThan(bodyStart)
  return source.slice(bodyStart, end)
}

function sqlWithoutComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim()
}

describe('device grant release contract', () => {
  it('uses the exact link fragment browser handoff and registration routes without legacy fields', () => {
    expect(protocol).toContain('http://10.44.100.100/connect#link=one-time-link-secret')
    expect(protocol).toContain('ucli://connect?server=http%3A%2F%2F10.44.100.100#link=<secret>')
    expect(protocol).not.toContain('#token=')
    expect(protocol).not.toContain('connect?link=')
    expect(fencedBlock(protocol, 'Preview HTTP', 'http')).toBe('POST /api/v1/auth/device-grants/preview\nContent-Type: application/json')
    expect(fencedBlock(protocol, 'Redeem HTTP', 'http')).toBe('POST /api/v1/auth/device-grants/redeem\nContent-Type: application/json')
    expect(fencedBlock(protocol, 'Refresh HTTP', 'http')).toBe('POST /api/v1/auth/token/refresh\nContent-Type: application/json')
    expect(fencedBlock(protocol, 'Refresh 响应头', 'http')).toBe('Cache-Control: no-store')
    expect(fencedBlock(protocol, 'Bootstrap HTTP', 'http')).toBe('GET /api/v1/client/bootstrap\nAuthorization: Bearer <accessToken>')
    expect(protocol).not.toMatch(/(?:GET|POST) \/api\/v1\/auth\/device\/(?:code|token|approve)/)
    expect(protocol).not.toContain('/api/v1/auth/invitations/accept')
  })

  it('publishes parseable preview, redeem, refresh, and bootstrap JSON contracts', () => {
    expect(jsonBlock('创建响应')).toEqual({
      id: 'grant-uuid', connectionUrl: 'http://10.44.100.100/connect#link=one-time-link-secret', expiresAt: null
    })
    expect(jsonBlock('Preview 请求')).toEqual({ link: '<secret>' })
    expect(jsonBlock('Preview 响应')).toEqual({
      account: { id: 'account-uuid', displayName: '成员姓名' },
      organization: { id: 'organization-uuid', name: '组织名称' },
      link: { status: 'AVAILABLE', expiresAt: '2026-09-02T04:00:00.000Z' },
      authorization: { status: 'AVAILABLE', expiresAt: null, serverTime: '2026-08-27T04:00:00.000Z' }
    })
    expect(jsonBlock('Redeem 请求')).toEqual({
      link: '<secret>',
      device: { installationId: '550e8400-e29b-41d4-a716-446655440000', name: '张三的工作站', platform: 'windows', clientVersion: '1.2.0' }
    })
    expect(jsonBlock('Redeem 响应')).toEqual({
      accessToken: 'jwt', refreshToken: 'opaque-refresh-token', expiresIn: 900,
      account: { id: 'account-uuid', displayName: '成员姓名' },
      organization: { id: 'organization-uuid', name: '组织名称' },
      authorization: { expiresAt: null, serverTime: '2026-08-27T04:00:00.000Z' }
    })
    expect(jsonBlock('Refresh 请求')).toEqual({ refreshToken: 'opaque-refresh-token' })
    expect(jsonBlock('Refresh 响应')).toEqual({
      accessToken: 'jwt', refreshToken: 'next-opaque-refresh-token', expiresIn: 900,
      authorization: { expiresAt: null, serverTime: '2026-08-27T04:00:00.000Z' }
    })
    expect(jsonBlock('Bootstrap 响应')).toEqual({
      organization: { id: 'organization-uuid', name: '组织名称', timezone: 'Asia/Shanghai' },
      gateway: { baseUrl: 'http://10.44.100.100/gateway' },
      models: [{ id: 'example-model', displayName: '示例模型', contextSize: 128000, protocols: ['openai_responses'] }],
      skillsCatalogUrl: 'http://10.44.100.100/api/v1/skills/catalog',
      authorization: { expiresAt: null, serverTime: '2026-08-27T04:00:00.000Z' }
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
      'invalid_link', 'link_expired', 'link_revoked', 'link_consumed',
      'grant_disabled', 'grant_expired', 'grant_bound', 'grant_deleted',
      'account_inactive', 'organization_inactive', 'invalid_device'
    ]) expect(protocol).toContain(code)
    expect(protocol).not.toContain('grant_already_bound')
    expect(clientUpgrade).not.toContain('grant_already_bound')
    expect(protocol).toContain('`grant_bound` 只适用于管理端 `POST /api/v1/admin/device-grants/:id/links`')
    expect(protocol).toContain('Preview/Redeem 则返回 `link_consumed`')
  })

  it('keeps the client independently implementable and confines raw credential material', () => {
    for (const text of [
      '独立安装、独立使用', '只维护一个当前服务端连接', 'POST /api/v1/auth/device-grants/preview',
      'POST /api/v1/auth/device-grants/redeem', 'POST /api/v1/auth/token/refresh',
      'GET /api/v1/client/bootstrap', '操作系统安全存储', '联系管理员延期',
      'link_expired', 'link_revoked', 'link_consumed', '服务端模型', '本地模型',
      '确认页关闭', '注册失败', '切换用户', '卸载时清空', 'UCLI 客户端仓库'
    ]) expect(clientUpgrade).toContain(text)
    expect(clientUpgrade).not.toMatch(/\]\([^)]*\.md\)/)

    for (const text of [
      '管理端创建、查看或重新生成设备授权 URL 的 `connectionUrl` 响应', '绝不返回裸链接秘密字段',
      '关闭只会清除当前页面 DOM 中的 URL 副本', '管理员仍可再次查看当前 URL 恢复副本',
      '弹窗关闭', '创建失败', '切换用户', '卸载时清空', 'secretHash` 与 refresh token 哈希永不展示',
      'URL query', '日志、异常、审计、storage'
    ]) expect(protocol).toContain(text)
    expect(protocol).not.toContain('对应的一次性 Vue 弹窗')
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

  it('publishes model capabilities, gateway catalog extensions, and stable route failures', () => {
    expect(jsonBlock('Gateway 模型列表响应')).toEqual({
      object: 'list',
      data: [{
        id: 'example-model', object: 'model', owned_by: 'ucli', display_name: '示例模型',
        context_size: 128000, protocols: ['openai_responses']
      }]
    })
    expect(jsonBlock('Gateway 路由错误响应')).toEqual({
      statusCode: 503,
      code: 'model_protocol_unavailable',
      message: 'The model does not support the requested protocol',
      requestId: 'request-uuid',
      retryable: false
    })

    for (const text of [
      'openai_responses', 'openai_chat', 'anthropic_messages',
      'model_protocol_unavailable', 'model_channel_unavailable', 'upstream_unavailable',
      'X-UCLI-Request-ID', 'Cache-Control: no-store', 'models[0]'
    ]) {
      expect(protocol).toContain(text)
      expect(modelProtocolUpgrade).toContain(text)
    }

    expect(protocol).toContain('`GEMINI` 是服务端内部上游/转换协议，仅贡献 `openai_chat`')
    expect(modelProtocolUpgrade).toContain('`GEMINI` 是服务端内部上游/转换协议，仅贡献 `openai_chat`')
    expect(protocol).not.toContain('`gemini` 能力选择')
    expect(modelProtocolUpgrade).not.toContain('`gemini` 能力选择')

    expect(sectionFencedBlock(modelProtocolUpgrade, '回传格式', 'yaml')).toBe(`timestamp: null
clientVersion: null
clientCommit: null
serverCommit: null
serverRuntimeImage: null
localContractGate: null
selectedModelId: "not-selected"
selectedProtocol: "not-selected"
failedStage: null
httpStatus: "not-received"
contentType: "not-received"
cacheControl: "not-received"
stableCode: "not-received"
requestId: "not-received"
retryable: null
streamReceivedNonEmptyData: false
authorizationExpiresAt: "not-recorded"
serverTimePresent: false
skillsCatalog: "NOT_RUN"
skillDownloadHash: "NOT_RUN"
cleanup: "NOT_RUN"`)
  })

  it('documents independent link operations and recovery boundaries', () => {
    expect(readme).toContain('链接 URL 有效期与授权有效期相互独立')
    expect(readme).toContain('重新生成链接会立即使上一个链接失效')
    expect(readme).toContain('连接 URL 使用 `MASTER_KEY` 加密')
    expect(readme).toContain('创建、查看或重新生成操作中显示')
    expect(deploy).toContain('回滚必须同时恢复与上一版应用镜像匹配的升级前数据库备份')
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
