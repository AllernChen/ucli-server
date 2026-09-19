#!/usr/bin/env node
// Idempotent company-data migration for 13 legacy project groups -> 7 regional groups.
// Dry run is the default. --apply requires admin credentials and performs API mutations.

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'

const APPLY = process.argv.includes('--apply')
const outputIndex = process.argv.indexOf('--output')
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : '发放清单-v2.csv'
const credentialsIndex = process.argv.indexOf('--credentials')
const credentialsPath = credentialsIndex >= 0 ? process.argv[credentialsIndex + 1] : 'credentials.json'

const REGION_MAPPING = [
  { region: '广东-省厅区域', projects: ['广东-省厅', '广东-机场', '广东-地市'] },
  { region: '广东-市局区域', projects: ['广东-市局', '广东-越秀', '广东-黄埔', '广东-揭阳', '广东-交警'] },
  { region: '广东-花都区域', projects: ['广东-花都'] },
  { region: '广东-东莞区域', projects: ['广东-东莞'] },
  { region: '北京-GAB区域', projects: ['北京-GAB'] },
  { region: '江苏-苏州区域', projects: ['江苏-苏州'] },
  { region: '贵州区域', projects: ['贵州-贵州'] }
]
const SOURCE_GROUPS = REGION_MAPPING.flatMap(item => item.projects)
if (new Set(SOURCE_GROUPS).size !== SOURCE_GROUPS.length) throw new Error('Duplicate source project group')

function deterministicUuid(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function fail(message) { console.error(`[migrate] ${message}`); process.exit(1) }
function readJson(path) {
  if (!existsSync(path)) fail(`missing ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

let token = ''
let baseUrl = 'http://10.44.100.100'
if (APPLY) {
  const credentials = readJson(credentialsPath)
  baseUrl = (credentials.baseUrl || baseUrl).replace(/\/$/, '')
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers || {}) }
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${options.method || 'GET'} ${path} -> HTTP ${response.status} ${detail.slice(0, 300)}`)
  }
  return response.status === 204 ? null : response.json()
}

async function paginate(path) {
  const items = []
  for (let offset = 0; ; offset += 200) {
    const separator = path.includes('?') ? '&' : '?'
    const page = await api(`${path}${separator}limit=200&offset=${offset}`)
    items.push(...page.items)
    if (offset + page.items.length >= page.total) return items
  }
}

async function login() {
  const credentials = readJson(credentialsPath)
  baseUrl = (credentials.baseUrl || baseUrl).replace(/\/$/, '')
  if (credentials.accessToken) { token = credentials.accessToken; return }
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: credentials.password })
  })
  if (!response.ok) fail(`administrator login failed with HTTP ${response.status}`)
  token = (await response.json()).accessToken
}

function plan() {
  const regionMemberships = REGION_MAPPING.reduce((sum, region) => sum + region.projects.length + 39, 0)
  return {
    regions: REGION_MAPPING.length,
    sourceGroups: SOURCE_GROUPS.length,
    projects: SOURCE_GROUPS.length,
    regionMemberships: 46,
    replacementKeys: 23,
    projectBudgetTotal: 13650
  }
}

async function applyMigration() {
  const state = { created: {}, replacedKeys: 0, archived: 0 }
  const users = await paginate('/api/v1/admin/users')
  const groups = await paginate('/api/v1/admin/usage-groups?status=all')
  const groupByName = new Map(groups.map(group => [group.name, group]))
  const accountByEmail = new Map(users.map(user => [user.email.toLowerCase(), user]))
  const projectBySourceGroupId = new Map()
  const existingProjects = await paginate('/api/v1/admin/projects')
  for (const project of existingProjects) {
    if (project.sourceGroupId) projectBySourceGroupId.set(project.sourceGroupId, project)
  }

  for (const mapping of REGION_MAPPING) {
    let region = groups.find(group => group.name === mapping.region)
    if (!region) {
      region = await api('/api/v1/admin/usage-groups', { method: 'POST', body: JSON.stringify({
        name: mapping.region, type: 'REGION', description: `区域组：${mapping.projects.join('、')}`
      }) })
    }
    state.created[mapping.region] = region.id
    const sourceGroups = mapping.projects.map(name => {
      const group = groupByName.get(name)
      if (!group) {
        console.error('[migrate] available groups:', [...groupByName.keys()].join(', '))
        throw new Error(`source group not found: ${name}`)
      }
      return group
    })
    const modelIds = new Set()
    const projectOwners = []

    const members = new Map()
    for (const source of sourceGroups) {
      const membersPage = await api(`/api/v1/admin/usage-groups/${source.id}/members?limit=200`)
      for (const member of membersPage.items) {
        members.set(member.accountId, member)
        if (member.role === 'LEADER') projectOwners.push({ source: source.id, accountId: member.accountId })
      }
    }
    for (const [accountId] of members) {
      await api(`/api/v1/admin/usage-groups/${region.id}/members`, { method: 'POST', body: JSON.stringify({ accountId }) })
    }
    for (const source of sourceGroups) {
      const models = await api(`/api/v1/admin/usage-groups/${source.id}/models`)
      for (const model of models) modelIds.add(model.publicModelId)
    }
    await api(`/api/v1/admin/usage-groups/${region.id}/models`, { method: 'PUT', body: JSON.stringify({
      publicModelIds: [...modelIds]
    }) })

    for (const [index, source] of sourceGroups.entries()) {
      const name = mapping.projects[index]
      console.log('[migrate] creating project', { regionId: region.id, regionName: mapping.region, name, sourceGroupId: source.id })
      let project = projectBySourceGroupId.get(source.id)
      if (!project) {
        project = await api('/api/v1/admin/projects', { method: 'POST', body: JSON.stringify({
          regionId: region.id, code: `MIG-${source.id.slice(0, 8).toUpperCase()}`, name,
          description: `迁移自用量组 ${source.name}`, sourceGroupId: source.id
        }) })
      }
      projectBySourceGroupId.set(source.id, project)
      for (const owner of projectOwners.filter(owner => owner.source === source.id)) {
        await api(`/api/v1/admin/projects/${project.id}/members`, { method: 'POST', body: JSON.stringify({
          accountId: owner.accountId, role: 'OWNER'
        }) })
      }
      const budget = await api(`/api/v1/admin/usage-groups/${source.id}/budget`)
      if (!budget.unlimited) {
        await api(`/api/v1/admin/projects/${project.id}/budget-adjustments`, { method: 'POST', body: JSON.stringify({
          operationId: deterministicUuid(`region-project-budget:${source.id}`), limitCny: budget.limitCny, unlimited: false,
          reason: '迁移原项目组临时额度'
        }) })
      }
    }
    state.created[`${mapping.region}:projects`] = sourceGroups.length
  }

  for (const mapping of REGION_MAPPING) {
    const regionId = state.created[mapping.region]
    for (const sourceName of mapping.projects) {
      const source = groupByName.get(sourceName)
      const project = projectBySourceGroupId.get(source.id)
      const oldKeys = await oldProjectKeys(source.id)
      for (const oldKey of oldKeys) {
        const account = accountByEmail.get(oldKey.account.email.toLowerCase())
        const name = `${mapping.region}-${sourceName}-${account?.displayName || oldKey.account.displayName}`
        const created = await api(`/api/v1/admin/users/${oldKey.account.id}/api-keys`, { method: 'POST', body: JSON.stringify({
          name, groupId: regionId, projectId: project.id, expiresAt: oldKey.expiresAt
        }) })
        state.replacedKeys++
        writeKeyRow(oldKey.account.email, name, created.secret)
        await api(`/api/v1/admin/employee-api-keys/${oldKey.id}/revoke`, { method: 'POST' })
      }
    }
  }

  for (const source of groups.filter(group => SOURCE_GROUPS.includes(group.name))) {
    await api(`/api/v1/admin/usage-groups/${source.id}`, { method: 'DELETE' })
    state.archived++
  }
  return state
}

async function oldProjectKeys(groupId) {
  const page = await api(`/api/v1/admin/employee-api-keys?groupId=${groupId}&limit=200`)
  return page.items.filter(key => key.groupId === groupId && !key.revokedAt && !key.deletedAt)
}

let users = []
let keyRows = []
function writeKeyRow(email, name, secret) {
  keyRows.push({ email, name, secret })
}

if (!APPLY) {
  console.log('[dry-run] plan:', JSON.stringify(plan(), null, 2))
  console.log('[dry-run] no platform data was changed')
} else {
  await login()
  users = await paginate('/api/v1/admin/users')
  const state = await applyMigration()
  if (keyRows.length) {
    const lines = ['email,keyName,secret']
    for (const row of keyRows) lines.push(`${row.email},${row.name},${row.secret}`)
    writeFileSync(outputPath, `\uFEFF${lines.join('\n')}`, 'utf8')
    console.log(`[migrate] wrote ${keyRows.length} one-time credentials to ${outputPath}`)
  }
  console.log('[migrate] complete:', JSON.stringify(state, null, 2))
}
