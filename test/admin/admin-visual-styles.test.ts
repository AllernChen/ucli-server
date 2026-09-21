import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('gives every raw textarea a dark-theme fallback', () => {
  const css = readFileSync(resolve('apps/admin/src/admin-visual-fixes.css'), 'utf8')
  expect(css).toMatch(/:where\(textarea\)\s*\{[^}]*background:\s*#0a1420/s)
})

it('keeps account and logout grouped at the bottom of the sidebar', () => {
  const app = readFileSync(resolve('apps/admin/src/App.vue'), 'utf8')
  const css = readFileSync(resolve('apps/admin/src/styles.css'), 'utf8')
  expect(app.indexOf('class="logout account"')).toBeGreaterThan(app.indexOf('<nav>'))
  expect(app.indexOf('class="logout" @click="logout"')).toBeGreaterThan(app.indexOf('class="logout account"'))
  expect(css).toMatch(/\.account\s*\{[^}]*margin-top:\s*auto/)
  expect(css).not.toMatch(/\.logout\s*\{[^}]*margin-top:\s*auto/)
})
