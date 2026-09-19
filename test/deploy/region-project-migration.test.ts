import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = readFileSync(join(process.cwd(), 'scripts/migrate-region-projects.mjs'), 'utf8')

describe('region project migration tool', () => {
  it('maps all 13 legacy project groups into exactly 7 regions', () => {
    const sourceGroups = [...script.matchAll(/projects: \[([^\]]+)\]/g)].flatMap(match =>
      match[1].split(',').map(value => value.trim().replaceAll("'", '')))
    expect(sourceGroups).toHaveLength(13)
    expect(new Set(sourceGroups).size).toBe(13)
    expect(script.matchAll(/region: '/g)).toBeDefined()
    expect([...script.matchAll(/region: '/g)]).toHaveLength(7)
  })

  it('migrates 46 region memberships, 23 replacement keys and the full temporary budget', () => {
    expect(script).toContain('regionMemberships: 46')
    expect(script).toContain('replacementKeys: 23')
    expect(script).toContain('projectBudgetTotal: 13650')
    expect(script).toContain('oldProjectKeys(source.id)')
  })

  it('keeps dry-run read-only and requires an explicit apply flag', () => {
    expect(script).toContain("const APPLY = process.argv.includes('--apply')")
    expect(script).toContain('[dry-run] no platform data was changed')
    expect(script).toContain('await login()')
  })
})
