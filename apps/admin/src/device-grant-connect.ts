export function readGrantToken(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token')?.trim() || ''
}

export function buildUcliConnectUrl(serverBaseUrl: string, token: string): string {
  const server = new URL(serverBaseUrl)
  if (!['http:', 'https:'].includes(server.protocol)) throw new Error('Unsupported server protocol')
  const target = new URL('ucli://connect')
  target.searchParams.set('server', server.origin)
  target.hash = `token=${encodeURIComponent(token)}`
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

export async function revalidateGrantAction<T extends { status: string }>(
  token: string, previewFetcher: (token: string) => Promise<T>
): Promise<{ preview?: T; state: GrantConnectionState }> {
  try {
    const preview = await previewFetcher(token)
    return { preview, state: connectionStateForGrantStatus(preview.status) }
  } catch {
    return { state: connectionStateForGrantStatus('') }
  }
}
