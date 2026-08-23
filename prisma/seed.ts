import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
async function main() {
  const models = [
    {
      id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', manufacturer: 'DeepSeek',
      manufacturerKey: 'deepseek', contextSize: 128000,
      priceId: '50000000-0000-4000-8000-000000000101', inputPerMillion: '3', outputPerMillion: '6',
      cachedPerMillion: '0.025', reasoningPerMillion: '6'
    },
    {
      id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', manufacturer: 'DeepSeek',
      manufacturerKey: 'deepseek', contextSize: 128000,
      priceId: '50000000-0000-4000-8000-000000000102', inputPerMillion: '1', outputPerMillion: '2',
      cachedPerMillion: '0.02', reasoningPerMillion: '2'
    }
  ]
  for (const model of models) {
    await prisma.publicModel.upsert({ where: { id: model.id }, update: {
      displayName: model.displayName, manufacturer: model.manufacturer, manufacturerKey: model.manufacturerKey,
      contextSize: model.contextSize
    }, create: {
      id: model.id, displayName: model.displayName, manufacturer: model.manufacturer,
      manufacturerKey: model.manufacturerKey, contextSize: model.contextSize, enabled: false
    } })
    const matchingPrices = await prisma.modelPriceVersion.findMany({ where: {
      publicModelId: model.id, deletedAt: null, enabled: true, currency: 'CNY',
      inputPerMillion: model.inputPerMillion, outputPerMillion: model.outputPerMillion,
      cachedPerMillion: model.cachedPerMillion, reasoningPerMillion: model.reasoningPerMillion
    }, select: { id: true } })
    const existingCatalogPrice = matchingPrices.find(price => price.id !== model.priceId)
    if (existingCatalogPrice) {
      await prisma.modelPriceVersion.updateMany({
        where: { id: model.priceId, deletedAt: null }, data: { enabled: false, deletedAt: new Date() }
      })
    } else if (!matchingPrices.length) {
      await prisma.modelPriceVersion.upsert({ where: { id: model.priceId }, update: {}, create: {
        id: model.priceId, publicModelId: model.id,
        inputPerMillion: model.inputPerMillion, outputPerMillion: model.outputPerMillion,
        cachedPerMillion: model.cachedPerMillion, reasoningPerMillion: model.reasoningPerMillion,
        currency: 'CNY', enabled: true, validFrom: new Date('2026-08-21T00:00:00.000Z')
      } })
    }
  }
}
main().finally(() => prisma.$disconnect())
