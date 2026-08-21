const BASE = import.meta.env.VITE_API_URL || ''
export function token() { return localStorage.getItem('ucli.accessToken') || '' }
export function snapshotModelTestMessages<T extends { role: string; content: string }>(messages: readonly T[]): T[] {
  return messages.map(message => ({ ...message }))
}
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData
  const response = await fetch(`${BASE}${path}`, {
    ...init, headers: { authorization: `Bearer ${token()}`, ...(isForm ? {} : { 'content-type': 'application/json' }), ...init.headers }
  })
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/v1/auth/login')) {
      localStorage.removeItem('ucli.accessToken')
      window.location.reload()
    }
    throw new Error((await response.json().catch(() => null))?.message || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}
export async function optional<T = any[]>(path: string): Promise<T> {
  try {
    const response = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token()}` } })
    return response.ok ? await response.json() as T : [] as T
  } catch { return [] as T }
}

export async function apiSse(
  path: string, init: RequestInit, onEvent: (event: string, data: any) => void
): Promise<void> {
  const response = await fetch(`${BASE}${path}`, {
    ...init, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...init.headers }
  })
  if (!response.ok || !response.body) {
    throw new Error((await response.json().catch(() => null))?.message || `HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const consume = (block: string) => {
    const event = block.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim() || 'message'
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('')
    if (!data) return
    let parsed: unknown = data
    try { parsed = JSON.parse(data) } catch { /* Keep plain-text event payload. */ }
    onEvent(event, parsed)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ''
      blocks.forEach(consume)
    }
    buffer += decoder.decode()
    if (buffer.trim()) consume(buffer)
  } finally { reader.releaseLock() }
}
