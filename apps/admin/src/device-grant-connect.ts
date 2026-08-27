export function readGrantLink(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('link')?.trim() || ''
}

export function buildUcliConnectUrl(serverBaseUrl: string, link: string): string {
  const server = new URL(serverBaseUrl)
  if (!['http:', 'https:'].includes(server.protocol)) throw new Error('Unsupported server protocol')
  const target = new URL('ucli://connect')
  target.searchParams.set('server', server.origin)
  target.hash = `link=${encodeURIComponent(link)}`
  return target.toString()
}

export type GrantConnectionState = { canConnect: boolean; label: string; message: string }

export function connectionStateForGrantStatus(status: string): GrantConnectionState {
  const unavailable = (label: string, message: string): GrantConnectionState => ({ canConnect: false, label, message })
  switch (status) {
    case 'AVAILABLE': return { canConnect: true, label: '可连接', message: '授权有效，可连接 UCLI。' }
    case 'DISABLED': return unavailable('已禁用', '授权已被管理员禁用，请联系管理员重新启用。')
    case 'EXPIRED': return unavailable('已过期', '授权已到期，请联系管理员续期。')
    case 'DELETED': return unavailable('已删除', '授权已被删除，不能再用于连接 UCLI。')
    case 'BOUND': return unavailable('已绑定', '授权已绑定设备，不能用于其他设备。')
    default: return unavailable('状态未知', '授权状态无法识别，请联系管理员。')
  }
}

export function connectionStateForLinkStatus(status: string): GrantConnectionState {
  const unavailable = (label: string, message: string): GrantConnectionState => ({ canConnect: false, label, message })
  switch (status) {
    case 'AVAILABLE': return { canConnect: true, label: 'URL 可用', message: '授权链接有效。' }
    case 'EXPIRED': return unavailable('URL 已过期', '授权链接已过期，请联系管理员创建新的授权链接。')
    case 'REVOKED': return unavailable('URL 已撤销', '授权链接已被撤销，请联系管理员创建新的授权链接。')
    case 'CONSUMED': return unavailable('URL 已使用', '授权链接已使用，请联系管理员创建新的授权链接。')
    default: return unavailable('URL 无效', '授权链接无效，请联系管理员创建新的授权链接。')
  }
}

export type GrantActionPreview = { link: { status: string }; authorization: { status: string } }

export function connectionStateForGrantPreview(preview: GrantActionPreview): GrantConnectionState {
  const linkState = connectionStateForLinkStatus(preview.link.status)
  return linkState.canConnect ? connectionStateForGrantStatus(preview.authorization.status) : linkState
}

export function connectionStateForPreviewFailure(code: string): GrantConnectionState {
  const linkStatus = new Map([
    ['invalid_link', 'INVALID'], ['link_expired', 'EXPIRED'],
    ['link_revoked', 'REVOKED'], ['link_consumed', 'CONSUMED']
  ]).get(code)
  if (linkStatus) return connectionStateForLinkStatus(linkStatus)
  const authorizationStatus = new Map([
    ['grant_disabled', 'DISABLED'], ['grant_expired', 'EXPIRED'],
    ['grant_deleted', 'DELETED'], ['grant_already_bound', 'BOUND']
  ]).get(code)
  if (authorizationStatus) return connectionStateForGrantStatus(authorizationStatus)
  const authorizationFailure = new Map<string, GrantConnectionState>([
    ['invalid_grant', { canConnect: false, label: '授权无效', message: '授权无效，请联系管理员创建新的授权链接。' }],
    ['account_inactive', { canConnect: false, label: '账号不可用', message: '账号或当前组织成员关系不可用，请联系管理员。' }],
    ['organization_inactive', { canConnect: false, label: '组织不可用', message: '组织不可用，请联系管理员。' }]
  ]).get(code)
  return authorizationFailure ?? connectionStateForGrantStatus('')
}

export function isTerminalLinkFailureState(state: GrantConnectionState): boolean {
  return ['URL 已过期', 'URL 已撤销', 'URL 已使用', 'URL 无效'].includes(state.label)
}

export function isTerminalAuthorizationFailureState(state: GrantConnectionState): boolean {
  return ['已禁用', '已过期', '已删除', '已绑定', '授权无效', '账号不可用', '组织不可用'].includes(state.label)
}

export async function revalidateGrantAction<T extends GrantActionPreview>(
  link: string, previewFetcher: (link: string) => Promise<T>
): Promise<{ preview?: T; state: GrantConnectionState }> {
  try {
    const preview = await previewFetcher(link)
    return { preview, state: connectionStateForGrantPreview(preview) }
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    return { state: connectionStateForPreviewFailure(code) }
  }
}

export function createExclusiveGrantActionGate() {
  let pending = false
  return {
    get pending() { return pending },
    async run(action: () => Promise<boolean>): Promise<boolean> {
      if (pending) return false
      pending = true
      try {
        return await action()
      } catch {
        return false
      } finally {
        pending = false
      }
    }
  }
}

export function createGrantActionLifecycle() {
  let disposed = false
  return {
    get disposed() { return disposed },
    dispose() { disposed = true },
    apply(effect: () => void) {
      if (disposed) return false
      effect()
      return true
    }
  }
}
