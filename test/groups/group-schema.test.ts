import { Prisma } from '@prisma/client'
import { expect, it } from 'vitest'

it('exposes separate group, member, key and durable budget records to the application', () => {
  const models = Prisma.dmmf.datamodel.models.map(model => model.name)
  expect(models).toEqual(expect.arrayContaining([
    'UsageGroup', 'GroupMember', 'GroupModelAccess', 'EmployeeApiKey', 'GroupBudgetPeriod', 'GroupBudgetEntry'
  ]))
})
