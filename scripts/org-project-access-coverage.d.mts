export type CoverageInput = {
  existingProjectMembers: Array<{ projectId: string; accountId: string }>
  existingActiveKeys: Array<{ projectId: string; accountId: string }>
  organizations: Array<{
    id: string
    organizationId: string
    name: string
    members: Array<{ accountId: string; displayName?: string }>
    projects: Array<{ id: string; name: string }>
  }>
}

export type CoveragePlan = {
  targetRelations: number
  missingProjectMembers: number
  missingActiveKeys: number
  alreadyCoveredRelations: number
  projectMemberOperations: Array<{ organizationId: string; projectId: string; accountId: string }>
  keyOperations: Array<{ organizationId: string; groupId: string; projectId: string; accountId: string }>
  byOrganization: Array<{
    organizationId: string
    organizationName: string
    missingProjectMembers: number
    missingActiveKeys: number
  }>
}

export function plannedCoverage(input: CoverageInput): CoveragePlan

export async function applyCoverage(
  prisma: any,
  plan: CoveragePlan,
  creatorAccountId: string,
  masterKey: Buffer
): Promise<{ projectMembersAdded: number; keysCreated: number }>
