import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildUcliConnectUrl, readGrantToken } from '../../apps/admin/src/device-grant-connect.js'
import { publicApi } from '../../apps/admin/src/api.js'

describe('device grant browser connection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the opaque token only from the fragment', () => {
    expect(readGrantToken('#token=grant%20secret')).toBe('grant secret')
    expect(readGrantToken('')).toBe('')
  })

  it('builds the exact UCLI protocol URL with a normalized origin', () => {
    expect(buildUcliConnectUrl('http://10.0.0.8:3000/path', 'grant secret')).toBe(
      'ucli://connect?server=http%3A%2F%2F10.0.0.8%3A3000#token=grant%20secret'
    )
  })

  it('rejects non-http server protocols', () => {
    expect(() => buildUcliConnectUrl('file:///tmp/server', 'secret')).toThrow('Unsupported server protocol')
  })

  it('sends preview requests without administrator authentication or login side effects', async () => {
    let requestInit: RequestInit | undefined
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init
      return new Response(JSON.stringify({ message: 'invalid_grant' }), { status: 401 })
    })
    const storage = { removeItem: vi.fn() }
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('localStorage', storage)

    await expect(publicApi('/api/v1/auth/device-grants/preview', {
      method: 'POST', body: JSON.stringify({ token: 'grant-secret' })
    })).rejects.toThrow('invalid_grant')

    expect(requestInit).toBeDefined()
    expect(requestInit?.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(requestInit?.headers).not.toHaveProperty('authorization')
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('keeps raw tokens out of the connection page DOM and diagnostic paths', async () => {
    const source = await readFile(resolve('apps/admin/src/views/Connect.vue'), 'utf8')
    expect(source).not.toMatch(/\{\{\s*(?:grant)?token\s*\}\}/i)
    expect(source).not.toMatch(/console\.[^(]+\([^)]*token/i)
    expect(source).not.toMatch(/route\.query|location\.search/i)
  })
})
