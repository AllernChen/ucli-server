import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { PrismaClient } from '@prisma/client'

export function plannedCoverage(input) {
  const byRelation = new Set(input.existingProjectMembers.map(item => `${item.projectId}:${item.accountId}`))
  const activeKeyByRelation = new Set(input.existingActiveKeys.map(item => `${item.projectId}:${item.accountId}`))
  const byOrganization = []
  const projectMemberOperations = []
  const keyOperations = []
  for (const organization of input.organizations) {
    let missingProjectMembers = 0
    let missingActiveKeys = 0
    for (const project of organization.projects) {
      for (const member of organization.members) {
        const relation = `${project.id}:${member.accountId}`
        if (!byRelation.has(relation)) {
          missingProjectMembers++
      projectMemberOperations.push({ organizationId: organization.organizationId, projectId: project.id, accountId: member.accountId })
        }
        if (!activeKeyByRelation.has(relation)) {
          missingActiveKeys++
          keyOperations.push({ organizationId: organization.organizationId, groupId: organization.id, projectId: project.id, accountId: member.accountId })
        }
      }
    }
    byOrganization.push({
      organizationId: organization.id,
      organizationName: organization.name,
      missingProjectMembers,
      missingActiveKeys
    })
  }
  return {
    targetRelations: input.organizations.reduce((sum, organization) => sum + organization.members.length * organization.projects.length, 0),
    missingProjectMembers: projectMemberOperations.length,
    missingActiveKeys: keyOperations.length,
    alreadyCoveredRelations: input.organizations.reduce((sum, organization) => sum + organization.members.length * organization.projects.length, 0) - projectMemberOperations.length,
    projectMemberOperations,
    keyOperations,
    byOrganization
  }
}

function hashSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('base64url')
}

function secretHint(secret) {
  return `••••${secret.slice(-6)}`
}

function encryptSecret(secret, masterKey) {
  if (masterKey.length !== 32) throw new Error('MASTER_KEY must be a base64 encoded 32-byte key')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return {
    secretCiphertext: ciphertext.toString('base64'),
    secretIv: iv.toString('base64'),
    secretTag: cipher.getAuthTag().toString('base64')
  }
}

function loadMasterKey() {
  if (!process.env.MASTER_KEY) throw new Error('MASTER_KEY is required')
  const decoded = Buffer.from(process.env.MASTER_KEY, 'base64')
  if (decoded.length !== 32) throw new Error('MASTER_KEY must be a base64 encoded 32-byte key')
  return decoded
}

export async function applyCoverage(prisma, plan, creatorAccountId, masterKey) {
  let projectMembersAdded = 0
  let keysCreated = 0
  await prisma.$transaction(async db => {
    for (const operation of plan.projectMemberOperations) {
      const existing = await db.projectMember.findUnique({ where: {
        projectId_accountId: { projectId: operation.projectId, accountId: operation.accountId }
      } })
      if (!existing) {
        await db.projectMember.create({ data: {
          organizationId: operation.organizationId, projectId: operation.projectId, accountId: operation.accountId
        } })
        projectMembersAdded++
      }
    }
    for (const operation of plan.keyOperations) {
      const secret = `ucli_sk_${randomBytes(32).toString('base64url')}`
      const existingKey = await db.employeeApiKey.findFirst({ where: {
        organizationId: operation.organizationId, groupId: operation.groupId,
        projectId: operation.projectId, accountId: operation.accountId,
        revokedAt: null, disabledAt: null, deletedAt: null
      }, select: { id: true } })
      if (existingKey) continue
      const encrypted = encryptSecret(secret, masterKey)
      await db.employeeApiKey.create({ data: {
        organizationId: operation.organizationId,
        groupId: operation.groupId,
        accountId: operation.accountId,
        projectId: operation.projectId,
        createdById: creatorAccountId,
        name: 'Organization project key',
        secretHash: hashSecret(secret),
        secretHint: secretHint(secret),
        ...encrypted
      } })
      keysCreated++
    }
  })
  return { projectMembersAdded, keysCreated }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const apply = process.argv.includes('--apply')
  const prisma = new PrismaClient()
  try {
    const organizations = await prisma.usageGroup.findMany({ where: {
      organizationId: { not: undefined }, orgType: { in: ['REGION', 'FUNCTIONAL', 'EXECUTIVE'] },
      enabled: true, archivedAt: null
    }, select: { id: true, organizationId: true, name: true } })
    const projects = await prisma.project.findMany({ where: {
      status: 'ACTIVE', organizationId: { not: undefined }, regionId: { not: undefined }
    }, select: { id: true, organizationId: true, regionId: true, name: true, status: true } })
    const memberships = await prisma.groupMember.findMany({ where: {
      removedAt: null, isPrimary: true
    }, select: { organizationId: true, groupId: true, accountId: true } })
    const inputOrganizations = []
    for (const organization of organizations) {
      const organizationProjects = projects.filter(project => project.organizationId === organization.organizationId && project.regionId === organization.id)
      const organizationMembers = memberships.filter(membership => membership.groupId === organization.id).map(membership => ({
        accountId: membership.accountId
      }))
      if (!organizationProjects.length || !organizationMembers.length) continue
      inputOrganizations.push({
        id: organization.id,
        organizationId: organization.organizationId,
        name: organization.name,
        projects: organizationProjects.map(project => ({ id: project.id, name: project.name })),
        members: organizationMembers.map(member => ({ accountId: member.accountId })),
        existingProjectMembers: [],
        existingActiveKeys: []
      })
    }
    const projectMembers = await prisma.projectMember.findMany({ select: { projectId: true, accountId: true } })
    const activeKeys = await prisma.employeeApiKey.findMany({ where: {
      revokedAt: null, disabledAt: null, deletedAt: null
    }, select: { projectId: true, accountId: true } })
    for (const organization of inputOrganizations) {
      organization.existingProjectMembers = projectMembers
      organization.existingActiveKeys = activeKeys
    }
    const plan = plannedCoverage(inputOrganizations.flatMap(organization => ({
      ...organization,
      existingProjectMembers: organization.existingProjectMembers.filter(item =>
        inputOrganizations.some(target => target.id === organization.id)),
      existingActiveKeys: organization.existingActiveKeys.filter(item =>
        inputOrganizations.some(target => target.id === organization.id))
    })))
    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      targetRelations: plan.targetRelations,
      missingProjectMembers: plan.missingProjectMembers,
      missingActiveKeys: plan.missingActiveKeys,
      byOrganization: plan.byOrganization
    }, null, 2))
    if (apply && plan.projectMemberOperations.length) {
      const masterKey = loadMasterKey()
      const creator = await prisma.membership.findFirst({ where: { role: 'PLATFORM_ADMIN' }, select: { accountId: true } })
      if (!creator) throw new Error('No platform administrator available as key creator')
      const result = await applyCoverage(prisma, plan, creator.accountId, masterKey)
      console.log(JSON.stringify(result))
    }
  } finally { await prisma.$disconnect() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
