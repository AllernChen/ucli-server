import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('gives every raw textarea a dark-theme fallback', () => {
  const css = readFileSync(resolve('apps/admin/src/admin-visual-fixes.css'), 'utf8')
  expect(css).toMatch(/:where\(textarea\)\s*\{[^}]*background:\s*#0a1420/s)
})
