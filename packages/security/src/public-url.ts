/** Return the deployment's public origin or fail before an authorization is written. */
export function requirePublicUrl(value = process.env.PUBLIC_URL): string {
  if (!value) throw new Error('PUBLIC_URL is required and must be an exact HTTP or HTTPS origin')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('PUBLIC_URL must be an exact HTTP or HTTPS origin')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password ||
    parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin === 'null' || value !== parsed.origin) {
    throw new Error('PUBLIC_URL must be an exact HTTP or HTTPS origin without path, query, hash, or credentials')
  }
  return parsed.origin
}
