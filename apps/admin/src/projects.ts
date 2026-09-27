export interface Project {
  id: string
  organizationId: string
  regionId: string
  code: string
  name: string
  description: string
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'
  category: 'BUSINESS' | 'DEPARTMENT'
  budgetMode: 'TOTAL' | 'MONTHLY'
  budgetTimezone: string
  region: { id: string; name: string }
  members?: ProjectMember[]
}

export interface ProjectMember {
  accountId: string
  role: 'OWNER' | 'CONTRIBUTOR' | 'VIEWER'
  membership?: { status: string; account: { id: string; displayName: string; email: string; status: string } }
}

export type MemberCandidate = {
  accountId: string
  displayName: string
  email: string
  inRegion: boolean
  orgUnits: Array<{ id: string; name: string; orgType: string; isPrimary: boolean }>
}

export interface ProjectBudget {
  projectId: string
  periodId: string | null
  periodKey: string
  budgetMode: 'TOTAL' | 'MONTHLY'
  budgetTimezone: string
  unlimited: boolean
  limitCny: string
  spentCny: string
  reservedCny: string
  uncertainCny: string
  availableCny: string | null
}
