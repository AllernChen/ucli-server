import { z } from 'zod'

const manifestSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(1024)
})

export function safeArchivePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return Boolean(normalized) && !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split('/').some(part => !part || part === '.' || part === '..')
}

export function parseSkillManifest(content: string) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
  if (!match) throw new TypeError('SKILL.md must start with YAML frontmatter')
  const metadata: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) continue
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return manifestSchema.parse(metadata)
}
