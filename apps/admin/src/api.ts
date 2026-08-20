const BASE = import.meta.env.VITE_API_URL || ''
export function token() { return localStorage.getItem('ucli.accessToken') || '' }
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
