import { createHash } from 'node:crypto'
import { parseSkillManifest, safeArchivePath } from './manifest.js'

const BLOCKED_EXTENSIONS = new Set(['.exe', '.dll', '.com', '.bat', '.cmd', '.ps1', '.msi', '.scr'])
const SECRET_PATTERN = /(?:sk-(?:ant-|live-|proj-)?[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|github_pat_[A-Za-z0-9_]{12,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/

export interface SkillEntry { name: string; size: number; content: Buffer; symbolicLink?: boolean }

export function scanSkillEntries(entries: SkillEntry[]) {
  if (!entries.length || entries.length > 500) throw new TypeError('Skill archive file count is invalid')
  const total = entries.reduce((sum, entry) => sum + entry.size, 0)
  if (total > 20 * 1024 * 1024) throw new TypeError('Skill archive exceeds 20 MB')
  let skillContent: string | null = null
  const files = entries.map(entry => {
    if (!safeArchivePath(entry.name) || entry.symbolicLink) throw new TypeError('Skill archive contains an unsafe path')
    const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
    if (BLOCKED_EXTENSIONS.has(extension)) throw new TypeError('Skill archive contains a blocked executable')
    if (entry.size !== entry.content.length || entry.size > 5 * 1024 * 1024) throw new TypeError('Skill archive entry size is invalid')
    const text = entry.content.toString('utf8')
    if (SECRET_PATTERN.test(text)) throw new TypeError('Skill archive contains a possible credential')
    if (entry.name === 'SKILL.md') skillContent = text
    return { path: entry.name, size: entry.size, sha256: createHash('sha256').update(entry.content).digest('hex') }
  })
  if (!skillContent) throw new TypeError('Skill archive requires SKILL.md')
  return { safe: true, manifest: parseSkillManifest(skillContent), files, totalBytes: total }
}
