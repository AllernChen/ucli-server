import { readFile } from 'node:fs/promises'

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
const forbiddenNames = /(?:^|\/)(?:new-api|one-api|calciumion|quantumnous)(?:$|\/)/i
const forbiddenLicenses = /AGPL/i
const violations = []
for (const [path, pkg] of Object.entries(lock.packages || {})) {
  if (forbiddenNames.test(`${path}/${pkg.name || ''}`) || forbiddenLicenses.test(String(pkg.license || ''))) {
    violations.push({ path, name: pkg.name, license: pkg.license })
  }
}
if (violations.length) {
  console.error(JSON.stringify(violations, null, 2))
  process.exit(1)
}
console.log(`License gate passed for ${Object.keys(lock.packages || {}).length} package records`)
