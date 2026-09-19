export interface Project {
  id: string
  organizationId: string
  regionId: string
  code: string
  name: string
  description: string
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'
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
