export interface ModelAccessPrincipal {
  groupId?: string | null
  projectId?: string | null
  organizationId: string
  accountId: string
  role: 'PLATFORM_ADMIN' | 'ORG_ADMIN' | 'MEMBER'
}

export function canAccessGroupModel(modelId: string, allowed: readonly string[] | null): boolean {
  return allowed === null || allowed.includes(modelId)
}

export interface ModelAccessPolicy {
  organizationId: string | null
  accountId: string | null
  role: ModelAccessPrincipal['role'] | null
}

export function canAccessModel(policies: ModelAccessPolicy[], principal: ModelAccessPrincipal): boolean {
  if (!policies.length) return true
  return policies.some(policy =>
    (policy.organizationId === null || policy.organizationId === principal.organizationId) &&
    (policy.accountId === null || policy.accountId === principal.accountId) &&
    (policy.role === null || policy.role === principal.role)
  )
}
