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
    expect(detailView).toContain('users/${requestedUserId}/device-grants')
    expect(detailView).toContain('deviceGrants')
    expect(detailView).toContain('devices')
    expect(detailView).toContain('当前组织成员状态')
  })

  it('protects creation secrets while retaining durable current-link recovery actions', () => {
    expect(detailView).toContain('以后仍可在授权列表中查看当前 URL')
    expect(detailView).toContain('navigator.clipboard.writeText(connectionUrl)')
    expect(detailView).toContain("createdSecret.value = null")
    expect(detailView).toContain('copyError.value')
    expect(detailView).toContain('watch(userId')
    expect(detailView).toContain('routeLifecycle.isCurrent')
    expect(detailView).toContain('loadLifecycle.isCurrent')
    expect(detailView).toContain('if (grantPending.value) return')
    expect(detailView).toContain('UserDetailGrant')
    expect(detailView).toContain('LinkExpiryFields')
    expect(detailView).toContain('DeviceGrantLinkActions')
    expect(detailView).toContain('linkExpiresAt')
  })

  it('guards user creation against duplicate submissions and closes only after its active request', () => {
    expect(usersView).toContain('const createPending = ref(false)')
    expect(usersView).toContain('if (createPending.value) return')
    expect(usersView).toContain(':close-disabled="createPending"')
    expect(usersView).toContain(':disabled="createPending"')
  })

  it('uses accessible focus-managed shared dialogs', () => {
    const drawer = readFileSync('apps/admin/src/components/Drawer.vue', 'utf8')
    const confirm = readFileSync('apps/admin/src/components/ConfirmDialog.vue', 'utf8')
    for (const source of [drawer, confirm]) {
      expect(source).toContain('role="dialog"')
      expect(source).toContain('aria-modal="true"')
      expect(source).toContain('aria-labelledby')
      expect(source).toContain('trapDialogFocus')
      expect(source).toContain("event.key === 'Escape'")
      expect(source).toContain('createDialogFocusLifecycle')
    }
    expect(drawer).toContain('aria-label="关闭"')
    expect(drawer).toContain('description?: string')
    expect(drawer).toContain('aria-describedby')
    expect(confirm).toContain('aria-describedby')
    expect(detailView).toContain('<Drawer :open="grantOpen"')
    expect(detailView).toContain('<Drawer :open="Boolean(createdSecret)"')
    expect(detailView).toContain('description="创建后会显示一次完整连接链接')
    expect(detailView).toContain('以后仍可在授权列表中查看当前 URL')
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
