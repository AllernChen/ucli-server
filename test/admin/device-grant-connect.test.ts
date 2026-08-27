import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildUcliConnectUrl, connectionStateForGrantStatus, createExclusiveGrantActionGate, createGrantActionLifecycle, readGrantLink, revalidateGrantAction } from '../../apps/admin/src/device-grant-connect.js'
import { publicApi } from '../../apps/admin/src/api.js'

describe('device grant browser connection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the opaque link only from the link fragment parameter', () => {
    expect(readGrantLink('#link=grant%20secret')).toBe('grant secret')
    expect(readGrantLink('#token=legacy')).toBe('')
    expect(readGrantLink('')).toBe('')
  })

  it('builds the exact UCLI protocol URL with a normalized origin', () => {
    expect(buildUcliConnectUrl('http://10.0.0.8:3000/path', 'grant secret')).toBe(
      'ucli://connect?server=http%3A%2F%2F10.0.0.8%3A3000#link=grant%20secret'
    )
  })

  it('rejects non-http server protocols', () => {
    expect(() => buildUcliConnectUrl('file:///tmp/server', 'secret')).toThrow('Unsupported server protocol')
  })

  it('only enables browser connection actions for available grants', () => {
    expect(connectionStateForGrantStatus('AVAILABLE')).toMatchObject({ canConnect: true })
    expect(connectionStateForGrantStatus('DISABLED')).toEqual({
      canConnect: false, label: '已禁用', message: '授权已被管理员禁用，请联系管理员重新启用。'
    })
    expect(connectionStateForGrantStatus('EXPIRED')).toEqual({
      canConnect: false, label: '已过期', message: '授权已到期，请联系管理员续期。'
    })
    expect(connectionStateForGrantStatus('DELETED')).toEqual({
      canConnect: false, label: '已删除', message: '授权已被删除，不能再用于连接 UCLI。'
    })
    expect(connectionStateForGrantStatus('BOUND')).toEqual({
      canConnect: false, label: '已绑定', message: '授权已绑定设备，不能用于其他设备。'
    })
    expect(connectionStateForGrantStatus('unexpected')).toEqual({
      canConnect: false, label: '状态未知', message: '授权状态无法识别，请联系管理员。'
    })
  })

  it('revalidates the latest grant status before allowing an action', async () => {
    const token = 'grant-secret'
    expect(connectionStateForGrantStatus('AVAILABLE').canConnect).toBe(true)
    for (const status of ['DISABLED', 'BOUND', 'EXPIRED', 'DELETED', 'unexpected']) {
      const fetcher = vi.fn(async (receivedToken: string) => ({ status }))
      const result = await revalidateGrantAction(token, fetcher)

      expect(fetcher).toHaveBeenCalledWith(token)
      expect(result.preview).toEqual({ status })
      expect(result.state.canConnect).toBe(false)
    }

    const fetcher = vi.fn(async (receivedToken: string) => ({ status: 'AVAILABLE' }))
    const result = await revalidateGrantAction(token, fetcher)
    expect(fetcher).toHaveBeenCalledWith(token)
    expect(result.preview).toEqual({ status: 'AVAILABLE' })
    expect(result.state.canConnect).toBe(true)
  })

  it('fails closed without exposing the token when revalidation fails', async () => {
    const token = 'grant-secret'
    const result = await revalidateGrantAction(token, async () => { throw new Error(token) })

    expect(result.preview).toBeUndefined()
    expect(result.state.canConnect).toBe(false)
    expect(JSON.stringify(result)).not.toContain(token)
  })

  it('serializes concurrent grant actions and releases the gate after completion, rejection, or denial', async () => {
    let completeFirst: (allowed: boolean) => void = () => {}
    const firstPreview = new Promise<boolean>(resolve => { completeFirst = resolve })
    const gate = createExclusiveGrantActionGate()
    let fetchCalls = 0

    const first = gate.run(async () => { fetchCalls++; return firstPreview })
    expect(gate.pending).toBe(true)
    expect(await gate.run(async () => { fetchCalls++; return true })).toBe(false)
    expect(fetchCalls).toBe(1)

    completeFirst(true)
    expect(await first).toBe(true)
    expect(gate.pending).toBe(false)
    expect(await gate.run(async () => false)).toBe(false)
    expect(gate.pending).toBe(false)
    expect(await gate.run(async () => { throw new Error('preview unavailable') })).toBe(false)
    expect(gate.pending).toBe(false)
    expect(await gate.run(async () => true)).toBe(true)
  })

  it('suppresses state, navigation, clipboard, and notice callbacks after disposal', async () => {
    let resolvePreview: () => void = () => {}
    const preview = new Promise<void>(resolve => { resolvePreview = resolve })
    const lifecycle = createGrantActionLifecycle()
    const calls = { state: 0, navigate: 0, clipboard: 0, notice: 0 }
    const waitForPreview = (async () => {
      await preview
      lifecycle.apply(() => { calls.state++; calls.navigate++; calls.clipboard++ })
    })()

    lifecycle.dispose()
    resolvePreview()
    await waitForPreview
    expect(calls).toEqual({ state: 0, navigate: 0, clipboard: 0, notice: 0 })

    let resolveClipboard: () => void = () => {}
    const clipboard = new Promise<void>(resolve => { resolveClipboard = resolve })
    const copyLifecycle = createGrantActionLifecycle()
    const waitForClipboard = (async () => {
      await clipboard
      copyLifecycle.apply(() => { calls.notice++ })
    })()
    copyLifecycle.dispose()
    resolveClipboard()
    await waitForClipboard
    expect(calls.notice).toBe(0)
  })

  it('sends link preview requests without administrator authentication or login side effects', async () => {
    let requestInit: RequestInit | undefined
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init
      return new Response(JSON.stringify({ message: 'invalid_grant' }), { status: 401 })
    })
    const storage = { removeItem: vi.fn() }
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('localStorage', storage)

    await expect(publicApi('/api/v1/auth/device-grants/preview', {
      method: 'POST', body: JSON.stringify({ link: 'grant-secret' })
    })).rejects.toThrow('invalid_grant')

    expect(requestInit).toBeDefined()
    expect(requestInit?.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(requestInit?.headers).not.toHaveProperty('authorization')
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('preserves stable link failure codes returned by the public API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'link_expired' }), { status: 400 })))

    await expect(publicApi('/api/v1/auth/device-grants/preview', {
      method: 'POST', body: JSON.stringify({ link: 'grant-secret' })
    })).rejects.toThrow('link_expired')
  })

  it('keeps raw links out of the connection page DOM and diagnostic paths', async () => {
    const source = (await readFile(resolve('apps/admin/src/views/Connect.vue'), 'utf8')).replace(/\r\n/g, '\n')
    expect(source).not.toMatch(/\{\{\s*(?:grant)?link\s*\}\}/i)
    expect(source).not.toMatch(/console\.[^(]+\([^)]*link/i)
    expect(source).not.toMatch(/route\.query|location\.search/i)
  })

  it('guards launch and copy actions behind the available status', async () => {
    const source = (await readFile(resolve('apps/admin/src/views/Connect.vue'), 'utf8')).replace(/\r\n/g, '\n')
    expect(source).toContain('v-if="connectionState.canConnect"')
    expect(source).toContain('{{ connectionState.label }}')
    expect(source).toContain('{{ connectionState.message }}')
    expect(source).toContain('createExclusiveGrantActionGate()')
    expect(source).toContain('createGrantActionLifecycle()')
    expect(source.match(/:disabled="actionPending"/g)).toHaveLength(2)
    expect(source).toContain('if (lifecycle.disposed) return')
    expect(source).toContain('if (!(await revalidateAction()) || lifecycle.disposed) return false\n    const target = connectionUrl()\n    window.location.href = target\n    grantLink = \'\'')
    expect(source).toContain('await navigator.clipboard.writeText(connectionUrl())\n      if (lifecycle.disposed) return false\n      notice.value')
    expect(source).toContain('const initialPreview = await previewGrant(grantLink)\n    if (lifecycle.disposed) return\n    updatePreview(initialPreview)')
    expect(source).toContain('lifecycle.apply(() => { actionPending.value = value })')
    expect(source).toContain('lifecycle.apply(() => { loading.value = false })')
    const availableActions = source.split('<template v-if="connectionState.canConnect">')[1]
    expect(availableActions).toContain('连接 UCLI')
    expect(availableActions).toContain('复制连接链接')
  })

  it('uses the link contract, clears the browser fragment, and shows independent expiries', async () => {
    const source = (await readFile(resolve('apps/admin/src/views/Connect.vue'), 'utf8')).replace(/\r\n/g, '\n')
    expect(source).toContain('readGrantLink(window.location.hash)')
    expect(source).toContain("body: JSON.stringify({ link })")
    expect(source).toContain("address.hash = ''")
    expect(source).toContain('URL 有效期')
    expect(source).toContain('授权有效期')
    expect(source).toContain('服务器时间')
    expect(source).toContain("grantLink = ''")
  })

  it('maps stable link failures to contact-administrator guidance', async () => {
    const source = (await readFile(resolve('apps/admin/src/views/Connect.vue'), 'utf8')).replace(/\r\n/g, '\n')
    for (const code of ['link_expired', 'link_revoked', 'link_consumed']) {
      expect(source).toContain(code)
    }
    expect(source).toContain('请联系管理员创建新的授权链接。')
  })
})
