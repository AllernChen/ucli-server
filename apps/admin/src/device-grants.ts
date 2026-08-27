export type ManagedUserStatus = 'ACTIVE' | 'DISABLED'
export type ManagedUserRole = 'MEMBER' | 'ORG_ADMIN' | 'PLATFORM_ADMIN'
export type DeviceGrantStatus = 'AVAILABLE' | 'BOUND' | 'DISABLED' | 'EXPIRED' | 'DELETED'
export type DeviceGrantLinkStatus = 'AVAILABLE' | 'EXPIRED' | 'REVOKED' | 'CONSUMED'
export type LinkExpiryMode = '1d' | '7d' | '30d' | 'permanent' | 'custom'

export interface LinkExpiryForm {
  mode: LinkExpiryMode
  customExpiresAt: string
}

export interface DeviceGrantLinkSummary {
  id: string
  secretHint: string
  status: DeviceGrantLinkStatus
  expiresAt: string | null
  createdAt: string
}

const linkExpiryDurations: Partial<Record<Exclude<LinkExpiryMode, 'permanent' | 'custom'>, number>> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
}

const linkStatusLabels: Record<DeviceGrantLinkStatus, string> = {
  AVAILABLE: '可用', EXPIRED: '已过期', REVOKED: '已撤销', CONSUMED: '已使用'
}

export function linkStatusLabel(status: DeviceGrantLinkStatus): string {
  return linkStatusLabels[status]
}

function customExpiryDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value)
  const date = new Date(value)
  if (!match || Number.isNaN(date.getTime())) throw new Error('请选择有效的 URL 有效期')

  const [, year, month, day, hour, minute, seconds = '0'] = match
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day) ||
    date.getHours() !== Number(hour) || date.getMinutes() !== Number(minute) || date.getSeconds() !== Number(seconds)) {
    throw new Error('请选择有效的 URL 有效期')
  }
  return date
}

export function linkExpiryPayload(form: LinkExpiryForm, now = new Date()): { expiresAt: string | null } {
  if (form.mode === 'permanent') return { expiresAt: null }
  if (form.mode === 'custom') {
    if (!form.customExpiresAt) throw new Error('请选择 URL 有效期')
    const custom = customExpiryDate(form.customExpiresAt)
    if (custom.getTime() <= now.getTime()) throw new Error('URL 有效期必须晚于当前时间')
    return { expiresAt: custom.toISOString() }
  }

  const duration = linkExpiryDurations[form.mode]
  if (!duration) throw new Error('请选择 URL 有效期')
  return { expiresAt: new Date(now.getTime() + duration).toISOString() }
}

export interface ManagedDevice {
  id: string
  name: string
  installationId: string | null
  platform: string | null
  clientVersion: string | null
  revokedAt: string | null
  lastSeenAt: string | null
  createdAt: string
  grant: UserDetailGrant | null
}

export interface DeviceGrantSummary {
  id: string
  accountId: string
  currentLink: DeviceGrantLinkSummary | null
  expiresAt: string | null
  disabledAt: string | null
  deletedAt: string | null
  boundAt: string | null
  deviceId: string | null
  createdById: string
  createdAt: string
  updatedAt: string
  status: DeviceGrantStatus
  device?: ManagedDevice | null
}

export interface UserDetailGrant {
  id: string
  currentLink: DeviceGrantLinkSummary | null
  expiresAt: string | null
  disabledAt: string | null
  deletedAt: string | null
  boundAt: string | null
  deviceId: string | null
  createdAt: string
  updatedAt: string
  status: DeviceGrantStatus
}

export interface ManagedUser {
  id: string
  organizationId: string
  email: string
  displayName: string
  status: ManagedUserStatus
  role: ManagedUserRole
  createdAt: string
  lastSeenAt: string | null
  deviceCount: number
  deviceGrantCount: number
}

export interface ManagedUserDetail extends ManagedUser {
  devices: ManagedDevice[]
  deviceGrants: UserDetailGrant[]
}

export interface DeviceGrantUserGroup {
  id: string
  email: string
  displayName: string
  deviceGrants: DeviceGrantSummary[]
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

export type GrantAction = 'disable' | 'enable' | 'edit-expiry' | 'delete'

const grantStatusLabels: Record<DeviceGrantStatus, string> = {
  AVAILABLE: '待绑定', BOUND: '已绑定', DISABLED: '已禁用', EXPIRED: '已过期', DELETED: '已删除'
}

export function grantStatusLabel(status: DeviceGrantStatus): string {
  return grantStatusLabels[status]
}

export function canViewGrantLink(grant: DeviceGrantSummary) {
  return grant.status === 'AVAILABLE' && grant.deviceId === null &&
    ['AVAILABLE', 'EXPIRED'].includes(grant.currentLink?.status || '')
}

export function canRegenerateGrantLink(grant: DeviceGrantSummary) {
  return grant.status === 'AVAILABLE' && grant.deviceId === null
}

export function grantActions(grant: Pick<DeviceGrantSummary, 'status'>): GrantAction[] {
  if (grant.status === 'DELETED') return []
  if (grant.status === 'DISABLED') return ['enable', 'edit-expiry', 'delete']
  return ['disable', 'edit-expiry', 'delete']
}

export function grantExpiryPayload(form: { permanent: boolean; expiresAt: string }) {
  if (form.permanent) return { expiresAt: null }
  if (!form.expiresAt) throw new Error('请选择有效期')
  return { expiresAt: new Date(form.expiresAt).toISOString() }
}

export function deviceGrantQuery(input: { status: string; q: string; limit: number; offset: number }): string {
  const query = new URLSearchParams({ status: input.status })
  if (input.q.trim()) query.set('q', input.q.trim())
  query.set('limit', String(input.limit))
  query.set('offset', String(input.offset))
  return query.toString()
}

export function createRequestLifecycle() {
  let generation = 0
  let disposed = false
  return {
    next() { return ++generation },
    isCurrent(requestGeneration: number) { return !disposed && requestGeneration === generation },
    dispose() { disposed = true; generation++ }
  }
}

export function createExclusiveAsyncRequestGate(onPending: (pending: boolean) => void = () => {}) {
  let pending = false
  let generation = 0
  let disposed = false
  const setPending = (value: boolean) => {
    if (pending === value) return
    pending = value
    onPending(value)
  }
  const isCurrent = (operation: number) => !disposed && operation === generation
  const invalidate = () => {
    generation++
    setPending(false)
  }
  return {
    get pending() { return pending },
    isCurrent,
    async run<T>(action: (operation: number) => Promise<T>): Promise<T | null> {
      if (pending || disposed) return null
      const operation = ++generation
      setPending(true)
      try {
        const value = await action(operation)
        return isCurrent(operation) ? value : null
      } finally {
        if (operation === generation) setPending(false)
      }
    },
    invalidate,
    dispose() {
      disposed = true
      invalidate()
    }
  }
}
