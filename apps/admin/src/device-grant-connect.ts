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
