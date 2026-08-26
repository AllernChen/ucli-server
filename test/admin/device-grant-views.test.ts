import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const usersView = readFileSync('apps/admin/src/views/Users.vue', 'utf8')
const detailView = readFileSync('apps/admin/src/views/UserDetail.vue', 'utf8')
const grantsView = readFileSync('apps/admin/src/views/DeviceGrants.vue', 'utf8')

describe('device grant admin views', () => {
  it('creates users and links each row to its detail page', () => {
    expect(usersView).toContain("api('/api/v1/admin/users'")
    expect(usersView).toContain('`/users/${user.id}`')
  })

  it('loads user grants and devices and creates nested grants', () => {
    expect(detailView).toContain('users/${userId}/device-grants')
    expect(detailView).toContain('deviceGrants')
    expect(detailView).toContain('devices')
  })

  it('protects one-time creation secrets and removes them on close', () => {
    expect(detailView).toContain('关闭后无法再次查看完整令牌')
    expect(detailView).toContain('navigator.clipboard.writeText(connectionUrl)')
    expect(detailView).toContain("createdSecret.value = null")
  })

  it('manages grouped grants through lifecycle endpoints', () => {
    expect(grantsView).toContain("api<Page<DeviceGrantUserGroup>>(`/api/v1/admin/device-grants?${deviceGrantQuery(filters)}`)")
    expect(grantsView).toContain('/disable')
    expect(grantsView).toContain('/enable')
    expect(grantsView).toContain("method: 'PATCH'")
    expect(grantsView).toContain("method: 'DELETE'")
  })

  it('warns that deleting a grant permanently revokes its device', () => {
    expect(grantsView).toContain('关联设备将被永久撤销')
  })
})
