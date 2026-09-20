export type OrganizationSnapshot = {
  activeDuplicateMembers: number
  executiveCount: number
  functionalCount: number
  regionCount: number
  legacyProjectCount: number
  departmentProjectCount: number
}

export function expectedOrganizationSnapshot(input: {
  executiveMembers: string[]
  functionalOrganizations: Array<{ name: string; memberCount: number }>
  regions: string[]
  departmentProjects: string[]
}): OrganizationSnapshot
