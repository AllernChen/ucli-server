export type PasswordBootstrapTarget = { id: string; email: string; displayName: string; status: string; passwordHash: string | null }

export function generateInitialPassword(length?: number): string
export function planPasswordBootstrap(accounts: PasswordBootstrapTarget[]): Promise<{
  targets: Array<{ id: string; email: string; displayName: string }>
  count: number
}>
export function applyPasswordBootstrap(prisma: any, accounts: PasswordBootstrapTarget[]): Promise<{
  changed: number
  rows: Array<{ displayName: string; email: string; initialPassword: string }>
}>
