import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
async function main() {
  await prisma.publicModel.upsert({ where: { id: 'ucli-default' }, update: {}, create: {
    id: 'ucli-default', displayName: 'UCLI Default', enabled: false
  } })
}
main().finally(() => prisma.$disconnect())
