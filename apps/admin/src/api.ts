const BASE = import.meta.env.VITE_API_URL || ''
export function token() { return localStorage.getItem('ucli.accessToken') || '' }
export async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}`, ...init.headers }
  })
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/v1/auth/login')) {
      localStorage.removeItem('ucli.accessToken')
      window.location.reload()
    }
    throw new Error((await response.json().catch(() => null))?.message || `HTTP ${response.status}`)
  }
  return response.json()
}
