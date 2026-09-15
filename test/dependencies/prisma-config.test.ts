import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('keeps the Prisma merge dependency safe for circular configuration values', () => {
  // Resolve from the actual consumer so a nested vulnerable copy cannot pass unnoticed.
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(resolve('node_modules/@prisma/config/package.json'))});
    const { deepmerge } = require('deepmerge-ts');
    const left = { name: 'left' };
    const right = { name: 'right' };
    left.self = left;
    right.self = right;
    const merged = deepmerge(left, right);
    assert.equal(merged.name, 'right');
    assert.equal(merged.self, merged);
    console.log('merge-ok');
  `], { encoding: 'utf8', timeout: 5000 })
  expect(output.trim()).toBe('merge-ok')
})

it('loads Prisma configuration through its real ESM merge import', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ucli-prisma-config-'))
  try {
    writeFileSync(join(directory, 'prisma.config.cjs'), "module.exports = { schema: 'prisma/schema.prisma', migrations: { path: 'prisma/migrations' } }")
    // A cold ESM config import can take over 9 seconds under the full suite's worker load.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { resolve } from 'node:path';
      import { loadConfigFromFile } from '@prisma/config';
      const root = ${JSON.stringify(directory)};
      const result = await loadConfigFromFile({ configRoot: root });
      assert.equal(result.error, undefined);
      assert.equal(result.config.schema, resolve(root, 'prisma/schema.prisma'));
      assert.equal(result.config.migrations.path, resolve(root, 'prisma/migrations'));
      console.log('config-ok');
    `], { encoding: 'utf8', timeout: 15000 })
    expect(output.trim()).toBe('config-ok')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 20000) // Allow the bounded 15-second child startup plus assertions and cleanup.
