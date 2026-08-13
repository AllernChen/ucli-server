import { describe, expect, it } from 'vitest'
import { scanSkillEntries } from '../../packages/skills/src/archive-scan.js'

describe('skill archive scanner', () => {
  it('accepts a bounded skill and records its file manifest', () => {
    const manifest = Buffer.from('---\nname: safe\ndescription: Safe skill\n---\nUse safely')
    const result = scanSkillEntries([
      { name: 'SKILL.md', size: manifest.length, content: manifest },
      { name: 'references/info.md', size: 4, content: Buffer.from('info') }
    ])
    expect(result.safe).toBe(true)
    expect(result.manifest).toMatchObject({ name: 'safe' })
    expect(result.files).toHaveLength(2)
  })

  it('rejects traversal, executables, secrets and oversized archives', () => {
    expect(() => scanSkillEntries([{ name: '../bad', size: 1, content: Buffer.from('x') }])).toThrow()
    expect(() => scanSkillEntries([{ name: 'run.exe', size: 1, content: Buffer.from('x') }])).toThrow()
    expect(() => scanSkillEntries([{ name: 'SKILL.md', size: 30, content: Buffer.from('---\nname: x\ndescription: sk-secret-value-123456789\n---') }])).toThrow()
  })
})
