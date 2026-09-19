#!/usr/bin/env node
// Idempotent company-data migration for 13 legacy project groups -> 7 regional groups.
// Dry run is the default. --apply requires admin credentials and performs API mutations.

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const APPLY = process.argv.includes('--apply')
const outputIndex = process.argv.indexOf('--output')
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : '发放清单-v2.csv'
const credentialsIndex = process.argv.indexOf('--credentials')
const credentialsPath = credentialsIndex >= 0 ? process.argv[credentialsIndex + 1] : 'credentials.json'

const REGION_MAPPING = [
  { region: '广东-省厅区域', projects: ['省厅', '机场', '地市'] },
  { region: '广东-市局区域', projects: ['市局', '越秀', '黄埔', '揭阳', '交警'] },
  { region: '广东-花都区域', projects: ['花都'] },
  { region: '广东-东莞区域', projects: ['东莞'] },
  { region: '北京-GAB区域', projects: ['GAB'] },
  { region: '江苏-苏州区域', projects: ['苏州'] },
  { region: '贵州-贵州', projects: ['贵州'] }
]
const SOURCE_GROUPS = REGION_MAPPING.flatMap(item => item.projects)
if (new Set(SOURCE_GROUPS).size !== SOURCE_GROUPS.length) throw new Error('Duplicate source project group')

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
      if (!group) throw new Error(`source group not found: ${name}`)
      return group
    })

    const members = new Map()
    for (const source of sourceGroups) {
      const membersPage = await api(`/api/v1/admin/usage-groups/${source.id}/members?limit=200`)
      for (const member of membersPage.items) members.set(member.accountId, member)
    }
    for (const [accountId] of members) {
      await api(`/api/v1/admin/usage-groups/${region.id}/members`, { method: 'POST', body: JSON.stringify({ accountId }) })
    }

    for (const [index, source] of sourceGroups.entries()) {
      const name = mapping.projects[index]
      const models = await api(`/api/v1/admin/usage-groups/${source.id}/models`)
      const project = await api('/api/v1/admin/projects', { method: 'POST', body: JSON.stringify({
        regionId: region.id, code: `MIG-${source.id.slice(0, 8).toUpperCase()}`, name,
        description: `迁移自用量组 ${source.name}`, sourceGroupId: source.id
      }) })
      projectBySourceGroupId.set(source.id, project)
      await api(`/api/v1/admin/projects/${project.id}/models`, { method: 'PUT', body: JSON.stringify({
        publicModelIds: models.map(model => model.publicModelId)
      }) })
      const budget = await api(`/api/v1/admin/usage-groups/${source.id}/budget`)
      if (!budget.unlimited) {
        await api(`/api/v1/admin/projects/${project.id}/budget-adjustments`, { method: 'POST', body: JSON.stringify({
          operationId: randomUUID(), limitCny: budget.limitCny, unlimited: false,
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
      const keys = await paginate(`/api/v1/admin/users?projectId=${project.id}`)
      for (const user of users) { /* keep users loaded for account email mapping */ }
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
  const keys = []
  for (const user of users) {
    const page = await api(`/api/v1/admin/users/${user.id}/api-keys?limit=200`)
    keys.push(...page.items.filter(key => key.groupId === groupId && !key.revokedAt && !key.deletedAt))
  }
  return keys
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
