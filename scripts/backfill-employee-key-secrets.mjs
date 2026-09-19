import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PrismaClient } from '@prisma/client'

function parseCsvLine(line) {
  const values = []
  let cursor = 0
  while (cursor <= line.length) {
    if (line[cursor] === '"') {
      let value = '', closed = false
      cursor++
      while (cursor < line.length) {
        if (line[cursor] === '"' && line[cursor + 1] === '"') { value += '"'; cursor += 2; continue }
        if (line[cursor] === '"') { cursor++; closed = true; break }
        value += line[cursor++]
      }
      if (!closed || (line[cursor] !== undefined && line[cursor] !== ',')) throw new Error('Malformed quoted CSV value')
      values.push(value)
      if (line[cursor] === ',') cursor++
      else if (cursor === line.length) break
      else throw new Error('Malformed CSV row')
    } else {
      const comma = line.indexOf(',', cursor)
      if (comma === -1) { values.push(line.slice(cursor)); break }
      values.push(line.slice(cursor, comma)); cursor = comma + 1
    }
  }
  return values
}

export async function loadSecretCsv(path) {
  let content
  try { content = await readFile(path, 'utf8') } catch { throw new Error('Secret CSV file not found or unreadable') }
  const lines = content.replace(/^\ufeff/, '').split(/\r?\n/).filter(line => line.trim())
  if (!lines.length) throw new Error('Secret CSV is empty')
  const headers = parseCsvLine(lines[0]).map(value => value.trim())
  const indexes = ['email', 'keyName', 'secret'].map(expected => headers.indexOf(expected))
  if (indexes.some(index => index === -1)) throw new Error('Secret CSV must contain email, keyName and secret columns')
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line)
    const row = Object.fromEntries(indexes.map((index, position) => [['email', 'keyName', 'secret'][position], (values[index] ?? '').trim()]))
    if (!row.email || !row.keyName || !row.secret) throw new Error('Secret CSV contains an empty required field')
    return row
  })
}

function hashSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('base64url')
}

function encryptSecret(secret, masterKey) {
  if (masterKey.length !== 32) throw new Error('MASTER_KEY must be a base64 encoded 32-byte key')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

function loadMasterKey() {
  if (!process.env.MASTER_KEY) throw new Error('MASTER_KEY is required')
  const decoded = Buffer.from(process.env.MASTER_KEY, 'base64')
  if (decoded.length !== 32) throw new Error('MASTER_KEY must be a base64 encoded 32-byte key')
  return decoded
}

export async function backfillEmployeeKeySecrets(prisma, rows) {
  if (!rows.length) throw new Error('Secret CSV contains no key rows')
  const masterKey = loadMasterKey()
  const plans = []
  const seen = new Set()
  let alreadyRecoverable = 0
  for (const [index, row] of rows.entries()) {
    const candidates = await prisma.employeeApiKey.findMany({
      where: { deletedAt: null, name: row.keyName, membership: { account: { email: row.email.toLowerCase() } } },
      select: { id: true, organizationId: true, accountId: true, groupId: true, projectId: true, secretHash: true,
        secretCiphertext: true, secretIv: true, secretTag: true }
    })
    if (candidates.length !== 1) throw new Error(`CSV row ${index + 1} did not match exactly one employee API key`)
    const key = candidates[0]
    if (seen.has(key.id)) throw new Error(`CSV row ${index + 1} matches a key already selected by another row`)
    seen.add(key.id)
    if (hashSecret(row.secret) !== key.secretHash) throw new Error(`CSV row ${index + 1} secret hash does not match stored key`)
    if (key.secretCiphertext && key.secretIv && key.secretTag) { alreadyRecoverable++; continue }
    plans.push({ key, encrypted: encryptSecret(row.secret, masterKey) })
  }
  await prisma.$transaction(async db => {
    for (const plan of plans) {
      await db.employeeApiKey.update({ where: { id: plan.key.id }, data: {
        secretCiphertext: plan.encrypted.ciphertext, secretIv: plan.encrypted.iv, secretTag: plan.encrypted.tag
      } })
      await db.auditLog.create({ data: { organizationId: plan.key.organizationId, action: 'employee_api_key.reveal_backfill',
        resourceType: 'employee_api_key', resourceId: plan.key.id, metadata: { source: 'issuance-csv' } } })
    }
  })
  return { matched: rows.length, encrypted: plans.length, alreadyRecoverable }
}

async function main() {
  const path = process.argv[2]
  if (!path) throw new Error('Usage: node scripts/backfill-employee-key-secrets.mjs <secret-csv>')
  const prisma = new PrismaClient()
  try {
    const result = await backfillEmployeeKeySecrets(prisma, await loadSecretCsv(path))
    console.log(JSON.stringify(result))
  } finally { await prisma.$disconnect() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
