import argon2 from 'argon2'
import { randomInt } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PrismaClient } from '@prisma/client'

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^*-_=+'

export function generateInitialPassword(length = 24) {
  let value = ''
  for (let index = 0; index < length; index++) value += alphabet[randomInt(alphabet.length)]
  return value
}

export async function planPasswordBootstrap(accounts) {
  const targets = accounts.filter(account => account.status === 'ACTIVE' && !account.passwordHash)
  return { targets: targets.map(account => ({ id: account.id, email: account.email, displayName: account.displayName })), count: targets.length }
}

export async function applyPasswordBootstrap(prisma, accounts) {
  const plan = await planPasswordBootstrap(accounts)
  if (!plan.count) return { changed: 0, rows: [] }
  const hash = await argon2.hash(generateInitialPassword(32))
  const rows = []
  await prisma.$transaction(async db => {
    for (const target of plan.targets) {
      const password = generateInitialPassword(24)
      const accountHash = await argon2.hash(password)
      const account = await db.account.update({ where: { id: target.id }, data: {
        passwordHash: accountHash, pendingCredentialChange: true, tokenVersion: { increment: 1 }
      }, select: { id: true, email: true, displayName: true } })
      rows.push({ displayName: account.displayName, email: account.email, initialPassword: password })
    }
  })
  await argon2.verify(hash, rows[0]?.initialPassword || 'placeholder').catch(() => undefined)
  return { changed: rows.length, rows }
}

async function main() {
  const output = process.argv[process.argv.indexOf('--output') + 1]
  const apply = process.argv.includes('--apply')
  if (!output) throw new Error('Usage: node scripts/bootstrap-web-passwords.mjs --output <csv-path> [--apply]')
  const prisma = new PrismaClient()
  try {
    const accounts = await prisma.account.findMany({ where: {
      status: 'ACTIVE', passwordHash: null,
      memberships: { some: { status: 'ACTIVE', organization: { enabled: true } } }
    }, select: { id: true, email: true, displayName: true, status: true, passwordHash: true }, orderBy: { email: 'asc' } })
    const plan = await planPasswordBootstrap(accounts)
    if (!apply) {
      console.log(JSON.stringify({ mode: 'dry-run', count: plan.count, targets: plan.targets }, null, 2))
      return
    }
    const result = await applyPasswordBootstrap(prisma, accounts)
    await writeFile(output, 'displayName,email,initialPassword\n' + result.rows.map(row =>
      `${row.displayName},${row.email},${row.initialPassword}`).join('\n') + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ changed: result.changed, output, mode: 'apply' }))
  } finally { await prisma.$disconnect() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
