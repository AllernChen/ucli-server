import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

describe('deployment source archive', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('exports install.sh with an executable LF shebang when autocrlf is enabled', () => {
    const repository = mkdtempSync(join(tmpdir(), 'ucli-archive-eol-'))
    temporaryDirectories.push(repository)
    copyFileSync(resolve('install.sh'), join(repository, 'install.sh'))
    if (existsSync(resolve('.gitattributes'))) {
      copyFileSync(resolve('.gitattributes'), join(repository, '.gitattributes'))
    }

    execFileSync('git', ['init', '--quiet'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'archive-test@example.invalid'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Archive Test'], { cwd: repository })
    execFileSync('git', ['-c', 'core.autocrlf=true', 'add', '.'], { cwd: repository })
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repository })

    const archive = join(repository, 'source.tar')
    const extracted = join(repository, 'extracted')
    mkdirSync(extracted)
    execFileSync('git', ['-c', 'core.autocrlf=true', 'archive', '--format=tar', `--output=${archive}`, 'HEAD'], { cwd: repository })
    execFileSync('tar', ['-xf', archive, '-C', extracted, 'install.sh'])

    const script = readFileSync(join(extracted, 'install.sh'))
    expect(script.subarray(0, 12).toString('utf8')).toBe('#!/bin/bash\n')
    expect(script.includes(Buffer.from('\r\n'))).toBe(false)
  })
})
