import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const protocol = readFileSync('docs/ucli-client-protocol.md', 'utf8')
const readme = readFileSync('README.md', 'utf8')
const deploy = readFileSync('DEPLOY.md', 'utf8')
const changelog = readFileSync('CHANGELOG.md', 'utf8')
const migration = readFileSync('prisma/migrations/202608260001_device_grants/migration.sql', 'utf8')
const schema = readFileSync('prisma/schema.prisma', 'utf8')

describe('device grant release contract', () => {
  it('replaces device-code registration with browser preview and per-device redeem', () => {
    expect(protocol).toContain('/connect#token=')
    expect(protocol).toContain('ucli://connect')
    expect(protocol).toContain('/api/v1/auth/device-grants/preview')
    expect(protocol).toContain('/api/v1/auth/device-grants/redeem')
    expect(protocol).toContain('"installationId"')
    expect(protocol).toContain('10 分钟')
    expect(protocol).toContain('一个授权令牌最多绑定一台设备')
    expect(protocol).toContain('同一用户可创建多个授权令牌')
    expect(protocol).not.toContain('/api/v1/auth/device/code')
  })

  it('preserves standalone local use while limiting each client to one server', () => {
    expect(protocol).toContain('独立安装和使用')
    expect(protocol).toContain('只允许连接一个服务端')
    expect(protocol).toContain('本地能力、本地数据和本地会话')
    expect(protocol).toContain('服务端模型、服务端技能和后续服务端能力')
  })

  it('defines credential handling, authorization metadata, and stable failures', () => {
    expect(protocol).toContain('操作系统安全存储保存 refresh token')
    expect(protocol).toContain('refresh token 轮换')
    expect(protocol).toContain('"authorization"')
    expect(protocol).toContain('"expiresAt"')
    expect(protocol).toContain('"serverTime"')
    expect(protocol).toContain('联系管理员延期')

    for (const code of [
      'invalid_grant',
      'grant_disabled',
      'grant_expired',
      'grant_already_bound',
      'grant_deleted',
      'account_inactive',
      'organization_inactive',
      'invalid_device'
    ]) expect(protocol).toContain(code)
  })

  it('publishes the managed-member, deployment, and breaking-change boundaries', () => {
    expect(readme).toContain('平台预创建普通成员')
    expect(readme).toContain('每台设备创建授权')
    expect(deploy).toContain('PUBLIC_URL')
    expect(deploy).toContain('精确的 UCLI 可访问 origin')
    expect(deploy).toContain('http://IP[:port]')
    expect(deploy).toContain('可信公司内网')
    expect(deploy).toContain('二进制回滚不受支持')
    expect(changelog).toContain('旧邀请、设备码和旧设备 refresh token 全部失效')
  })

  it('drops the legacy device-code enum only after its dependent table', () => {
    const tableDrop = migration.indexOf('DROP TABLE "device_authorizations"')
    const enumDrop = migration.indexOf('DROP TYPE "DeviceCodeStatus"')

    expect(tableDrop).toBeGreaterThanOrEqual(0)
    expect(enumDrop).toBeGreaterThan(tableDrop)
    expect(schema).not.toContain('enum DeviceCodeStatus')
  })
})
