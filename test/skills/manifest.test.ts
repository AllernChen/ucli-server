import { describe, expect, it } from 'vitest'
import { parseSkillManifest, safeArchivePath } from '../../packages/skills/src/manifest.js'

describe('skill package validation', () => {
  it('reads required SKILL.md metadata', () => {
    expect(parseSkillManifest('---\nname: code-review\ndescription: Review code safely\n---\nInstructions'))
      .toMatchObject({ name: 'code-review', description: 'Review code safely' })
  })

  it('rejects traversal, absolute paths, and missing metadata', () => {
    expect(safeArchivePath('assets/icon.png')).toBe(true)
    expect(safeArchivePath('../secret')).toBe(false)
    expect(safeArchivePath('/etc/passwd')).toBe(false)
    expect(() => parseSkillManifest('No frontmatter')).toThrow()
  })
})
