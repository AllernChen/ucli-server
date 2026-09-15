import 'reflect-metadata'
import { readFile } from 'node:fs/promises'
import { PrismaService } from '../packages/database/src/prisma.service.js'
import { DeviceGrantsService } from '../apps/api/src/device-grants.service.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function localRehearsalUrl(value: string | undefined) {
  if (!value) throw new Error('Explicit local TEST_DATABASE_URL is required')
  const url = new URL(value)
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !/^\/ucli_test[a-z0-9_]*$/i.test(url.pathname) || url.search || url.hash) throw new Error('Only a loopback ucli_test database without URL options is allowed')
  return value
}

export async function rehearseGroupAccess(input: { url?: string; organizationId: string; actorId?: string; mappings?: unknown; apply?: boolean }) {
  const url = localRehearsalUrl(input.url)
  if (!uuid.test(input.organizationId) || (input.actorId && !uuid.test(input.actorId))) throw new Error('Organization/actor UUID required')
  if (input.apply && !input.mappings) throw new Error('Applying requires an explicit mapping')
  const mappings = input.mappings
  if (mappings !== undefined && (!Array.isArray(mappings) || !mappings.length || mappings.length > 1000 || mappings.some(m =>
    !m || typeof m !== 'object' || m.organizationId !== input.organizationId || !uuid.test(m.accountId) || !uuid.test(m.grantId) || !uuid.test(m.groupId)))) {
    throw new Error('Mapping must contain 1–1000 rows with the same organizationId and valid accountId/grantId/groupId UUIDs')
  }
  const db = new PrismaService({ datasources: { db: { url } } })
  try {
    const service = new DeviceGrantsService(db)
    if (Array.isArray(mappings)) {
      const actor = input.actorId && await db.membership.findFirst({ where: { organizationId: input.organizationId, accountId: input.actorId,
        role: { in: ['PLATFORM_ADMIN', 'ORG_ADMIN'] }, status: 'ACTIVE', account: { status: 'ACTIVE' }, organization: { enabled: true } } })
      if (!actor) throw new Error('An active administrator in the target organization is required')
      return await service.assignGroups(input.organizationId, actor.accountId, mappings.map(m => ({ accountId: m.accountId, grantId: m.grantId, groupId: m.groupId })), !input.apply)
    }
    return { dryRun: true, ...await service.ungrouped(input.organizationId, { offset: 0, limit: 200 }) }
  } finally { await db.$disconnect() }
}

async function main() {
  const args = process.argv.slice(2)
  const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
  try {
    const mapping = value('--mapping')
    const result = await rehearseGroupAccess({ url: process.env.TEST_DATABASE_URL, organizationId: value('--organization') || '', actorId: value('--actor'),
      mappings: mapping ? JSON.parse(await readFile(mapping, 'utf8')) : undefined, apply: args.includes('--apply') })
    console.log(JSON.stringify(result, null, 2))
  } catch (e) { console.error(e instanceof Error ? e.message : 'Migration rehearsal failed'); process.exitCode = 1 }
}
if (typeof require !== 'undefined' && require.main === module) void main()
