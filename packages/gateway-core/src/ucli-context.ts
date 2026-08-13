const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/
const CLI_TYPES = new Set(['claude', 'codex', 'opencode', 'ucode'])

export interface UcliContext {
  sessionId: string | null
  projectId: string | null
  cliType: string | null
  clientVersion: string | null
  timezone: string | null
}

type HeaderValue = string | string[] | undefined

function first(value: HeaderValue): string | null {
  const result = Array.isArray(value) ? value[0] : value
  return typeof result === 'string' && result.trim() ? result.trim() : null
}

function optionalUuid(value: HeaderValue, name: string): string | null {
  const result = first(value)
  if (result && !UUID.test(result)) throw new TypeError(`${name} must be a UUID`)
  return result
}

export function parseUcliContext(headers: Record<string, HeaderValue>): UcliContext {
  const cliType = first(headers['x-ucli-cli-type'])
  if (cliType && !CLI_TYPES.has(cliType)) throw new TypeError('Invalid UCLI CLI type')
  const clientVersion = first(headers['x-ucli-client-version'])
  if (clientVersion && !VERSION.test(clientVersion)) throw new TypeError('Invalid UCLI client version')
  const timezone = first(headers['x-ucli-timezone'])
  if (timezone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format() }
    catch { throw new TypeError('Invalid UCLI timezone') }
  }
  return {
    sessionId: optionalUuid(headers['x-ucli-session-id'], 'Session ID'),
    projectId: optionalUuid(headers['x-ucli-project-id'], 'Project ID'),
    cliType,
    clientVersion,
    timezone
  }
}
