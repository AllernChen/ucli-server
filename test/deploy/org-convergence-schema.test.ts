import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('organization convergence schema', () => {
  it('adds organization kind, project category, and self-approval without dropping rollback columns', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8')
    expect(schema).toContain('enum OrgUnitType')
    expect(schema).toContain('orgType OrgUnitType')
    expect(schema).toContain('enum ProjectCategory')
    expect(schema).toContain('category ProjectCategory')
    expect(schema).toContain('selfApproved Boolean @default(false)')
    expect(schema).toContain('type UsageGroupType')
    expect(schema).toContain('regionId String @map("region_id")')
  })

  it('keeps the migration additive and creates partial uniqueness', () => {
    const sql = readFileSync('prisma/migrations/202609200001_org_project_convergence/migration.sql', 'utf8')
    expect(sql).toContain('CREATE TYPE "OrgUnitType"')
    expect(sql).toContain('CREATE TYPE "ProjectCategory"')
    expect(sql).toContain('org_unit_one_active_membership_where_removed_null')
    expect(sql).toContain('one_department_project_per_owner_where_active')
    expect(sql).not.toContain('DROP TABLE')
    expect(sql).not.toContain('DROP COLUMN')
  })
})
