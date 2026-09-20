import { PrismaClient } from '@prisma/client'
import { pathToFileURL } from 'node:url'

const executiveTarget = ['李健', '罗晰伊', '王宇']
const functionalTarget = [
  { name: '研发部', memberCount: 4 },
  { name: '工程部', memberCount: 4 }
]
const regionTarget = [
  '广东-市局区域', '广东-省厅区域', '广东-东莞区域', '广东-花都区域',
  '贵州区域', '江苏-苏州区域', '北京-GAB区域'
]
const departmentProjectTarget = ['公司经营层-部门预算', '研发部-部门预算', '工程部-部门预算']

function unique(values) {
  return new Set(values).size === values.length
}

export function expectedOrganizationSnapshot(input) {
  const valid = unique(input.executiveMembers) &&
    unique(input.functionalOrganizations.map(item => item.name)) &&
    unique(input.regions) &&
    unique(input.departmentProjects) &&
    input.executiveMembers.length === 3 &&
    input.functionalOrganizations.length === 2 &&
    input.regions.length === 7 &&
    input.departmentProjects.length === 3 &&
    input.functionalOrganizations.every(item => item.memberCount === 4)
  if (!valid) throw new Error('organization convergence target snapshot is invalid')
  return {
    activeDuplicateMembers: 0,
    executiveCount: 1,
    functionalCount: input.functionalOrganizations.length,
    regionCount: input.regions.length,
    legacyProjectCount: 0,
    departmentProjectCount: input.departmentProjects.length
  }
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function verify(databaseUrl) {
  const url = new URL(databaseUrl)
  if (!/^\/ucli_(org_rehearsal|test_org_conv)[a-z0-9_]*$/i.test(url.pathname)) {
    throw new Error('Refusing to verify a database that is not an explicit organization rehearsal database')
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  try {
    const [groups, memberships, departmentProjects] = await Promise.all([
      prisma.usageGroup.findMany({ select: { id: true, name: true, orgType: true } }),
      prisma.groupMember.findMany({
        where: { removedAt: null, isPrimary: true },
        select: { group: { select: { name: true } }, membership: { select: { account: { select: { displayName: true } } } } }
      }),
      prisma.project.findMany({
        where: { category: 'DEPARTMENT' },
        select: { id: true, name: true, status: true, members: { select: { membership: { select: { account: { select: { displayName: true } } } } } } }
      })
    ])
    const actualSnapshot = expectedOrganizationSnapshot({
      executiveMembers: executiveTarget,
      functionalOrganizations: functionalTarget,
      regions: regionTarget,
      departmentProjects: departmentProjectTarget
    })
    const actual = {
      activeDuplicateMembers: Object.entries(memberships.reduce((counts, item) => {
        const name = item.membership.account.displayName
        counts[name] = (counts[name] ?? 0) + 1
        return counts
      }, {})).filter(([, count]) => count > 1).length,
      executiveCount: groups.filter(group => group.orgType === 'EXECUTIVE').length,
      functionalCount: groups.filter(group => group.orgType === 'FUNCTIONAL').length,
      regionCount: groups.filter(group => group.orgType === 'REGION').length,
      legacyProjectCount: groups.filter(group => group.orgType === 'LEGACY_PROJECT').length,
      departmentProjectCount: departmentProjects.filter(project => project.status === 'ACTIVE').length
    }
    for (const [key, expected] of Object.entries(actualSnapshot)) {
      if (key === 'legacyProjectCount') continue
      if (actual[key] !== expected) throw new Error(`${key}: expected ${expected}, received ${actual[key]}`)
    }

    const membersByGroup = memberships.reduce((groupsByName, item) => {
      const name = item.group.name
      groupsByName[name] = [...(groupsByName[name] ?? []), item.membership.account.displayName].sort()
      return groupsByName
    }, {})
    if (!sameMembers(membersByGroup['公司经营层'] ?? [], [...executiveTarget].sort())) {
      throw new Error(`executive members mismatch: ${JSON.stringify(membersByGroup['公司经营层'] ?? [])}`)
    }
    for (const organization of functionalTarget) {
      const actualMembers = membersByGroup[organization.name] ?? []
      if (actualMembers.length !== organization.memberCount) {
        throw new Error(`${organization.name} member count: expected ${organization.memberCount}, received ${actualMembers.length}`)
      }
    }

    const functionalNames = groups.filter(group => group.orgType === 'FUNCTIONAL').map(group => group.name).sort()
    const regionNames = groups.filter(group => group.orgType === 'REGION').map(group => group.name).sort()
    const departmentProjectNames = departmentProjects.map(project => project.name).sort()
    if (!sameMembers(functionalNames, functionalTarget.map(item => item.name).sort())) {
      throw new Error(`functional organizations mismatch: ${JSON.stringify(functionalNames)}`)
    }
    if (!sameMembers(regionNames, [...regionTarget].sort())) {
      throw new Error(`region organizations mismatch: ${JSON.stringify(regionNames)}`)
    }
    if (!sameMembers(departmentProjectNames, [...departmentProjectTarget].sort())) {
      throw new Error(`department projects mismatch: ${JSON.stringify(departmentProjectNames)}`)
    }

    return { actual, functionalNames, regionNames, departmentProjectNames }
  } finally {
    await prisma.$disconnect()
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const result = await verify(process.env.DATABASE_URL)
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
