import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('region and project budget schema', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
  const migration = readFileSync(
    join(process.cwd(), 'prisma/migrations/202609190001_region_projects_project_budgets/migration.sql'),
    'utf8'
  )

  it('adds region usage groups and first-class projects', () => {
    expect(schema).toContain('REGION')
    expect(schema).toContain('model Project {')
    expect(schema).toContain('model ProjectMember {')
    expect(migration).toContain('CREATE TABLE "projects"')
    expect(migration).toContain('CREATE TABLE "project_members"')
  })

  it('binds credentials and usage logs to budget projects', () => {
    expect(schema).toContain('projectId String? @map("project_id") @db.Uuid')
    expect(schema).toContain('budgetProjectId String? @map("budget_project_id") @db.Uuid')
    expect(migration).toContain('ALTER TABLE "employee_api_keys" ADD COLUMN     "project_id" UUID')
    expect(migration).toContain('ALTER TABLE "device_grants" ADD COLUMN     "project_id" UUID')
    expect(migration).toContain('ALTER TABLE "usage_logs" ADD COLUMN     "budget_project_id" UUID')
  })

  it('creates durable project budget tables', () => {
    expect(schema).toContain('model ProjectBudgetPeriod {')
    expect(schema).toContain('model ProjectBudgetEntry {')
    expect(schema).toContain('model ProjectBudgetApplication {')
    expect(migration).toContain('CREATE TABLE "project_budget_periods"')
    expect(migration).toContain('CREATE TABLE "project_budget_entries"')
    expect(migration).toContain('CREATE TABLE "project_budget_applications"')
  })
})
