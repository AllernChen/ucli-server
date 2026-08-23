import { Prisma } from '@prisma/client'

export async function lockCatalogRecord(transaction: Prisma.TransactionClient, key: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS "lockResult"
  `)
}

export async function lockChannelModelRecord(transaction: Prisma.TransactionClient, id: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id"::text AS "id"
    FROM "channel_models"
    WHERE "id" = ${id}::uuid
    FOR UPDATE
  `)
}
