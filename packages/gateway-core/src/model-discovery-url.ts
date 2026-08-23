export function validateModelDiscoveryUrl(value: string, baseUrl: string): URL {
  let discoveryUrl: URL
  let channelBaseUrl: URL
  try {
    discoveryUrl = new URL(value)
    channelBaseUrl = new URL(baseUrl)
  } catch {
    throw new Error('Model discovery URL must be a valid HTTP(S) URL')
  }
  if (!['http:', 'https:'].includes(discoveryUrl.protocol) || discoveryUrl.username || discoveryUrl.password) {
    throw new Error('Model discovery URL must be an HTTP(S) URL without credentials')
  }
  if (discoveryUrl.origin !== channelBaseUrl.origin) {
    throw new Error('Model discovery URL must use the same origin as channel base URL')
  }
  return discoveryUrl
}
