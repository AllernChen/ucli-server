export type ManagedUserStatus = 'ACTIVE' | 'DISABLED'
export type ManagedUserRole = 'MEMBER' | 'ORG_ADMIN' | 'PLATFORM_ADMIN'
export type DeviceGrantStatus = 'AVAILABLE' | 'BOUND' | 'DISABLED' | 'EXPIRED' | 'DELETED'

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
  tokenHint: string
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
  tokenHint: string
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
