import type { PrismaClient } from '@prisma/client'

export type SecretCsvRow = { email: string; keyName: string; secret: string }
export type BackfillResult = { matched: number; encrypted: number; alreadyRecoverable: number }

export function loadSecretCsv(path: string): Promise<SecretCsvRow[]>
export function backfillEmployeeKeySecrets(prisma: PrismaClient, rows: SecretCsvRow[]): Promise<BackfillResult>
