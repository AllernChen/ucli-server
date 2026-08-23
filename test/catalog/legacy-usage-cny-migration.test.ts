import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('legacy DeepSeek usage CNY migration', () => {
  const path = join(process.cwd(), 'prisma/migrations/202608210005_legacy_usage_costs_to_cny/migration.sql')

  it('converts only the recognized legacy USD snapshot and preserves its audit values', () => {
    expect(existsSync(path)).toBe(true)
    const migration = readFileSync(path, 'utf8')
    expect(migration).toContain(`"public_model_id" = 'deepseek-v4-pro'`)
    expect(migration).toContain(`"cost_snapshot"->>'currency' = 'USD'`)
    expect(migration).toContain(`"cost_snapshot"->>'inputPerMillion' IN ('0.435', '0.43500000')`)
    expect(migration).toContain(`'legacyPriceSnapshot', "cost_snapshot"`)
    expect(migration).toContain(`'legacyCost', "cost_usd"::text`)
    expect(migration).toContain(`'currency', 'CNY'`)
  })
})
