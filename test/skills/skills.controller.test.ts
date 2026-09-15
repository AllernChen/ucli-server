import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import zlib from 'node:zlib'
import { SkillsController } from '../../apps/api/src/skills.controller.js'
import { jsonSafe } from '../../packages/http/src/json.js'

describe('skills catalog controller', () => {
  it('rejects an oversized ZIP entry before allocating its declared contents', async () => {
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('small'))
    const buffer = zip.toBuffer()
    const centralHeader = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    expect(centralHeader).toBeGreaterThan(0)
    buffer.writeUInt32LE(6 * 1024 * 1024, centralHeader + 24)
    // Guard the dangerous allocation in the real ZIP reader; never allocate a bomb in the test.
    const originalAlloc = Buffer.alloc
    const allocation = vi.spyOn(Buffer, 'alloc').mockImplementation((size, ...args) => {
      if (size >= 6 * 1024 * 1024) throw new Error('unsafe ZIP allocation attempted')
      return originalAlloc(size, ...args)
    })
    const inflation = vi.spyOn(zlib, 'inflateRawSync').mockImplementation(() => {
      throw new Error('unsafe ZIP decompression attempted')
    })
    try {
      const controller = new SkillsController({} as any, {} as any)
      await expect(controller.version('skill', { version: '1.0.0' }, { buffer } as Express.Multer.File))
        .rejects.toThrow('Skill archive entry size is invalid')
    } finally { allocation.mockRestore(); inflation.mockRestore() }
  })

  it('emits sizeBytes as a safe JSON number for client contract parsing', async () => {
    const prisma = {
      skillVersion: {
        findMany: async () => [{
          id: '10000000-0000-4000-8000-000000000001',
          version: '1.0.0',
          sha256: 'a'.repeat(64),
          sizeBytes: 1024n,
          publishedAt: new Date('2026-08-30T00:00:00.000Z'),
          createdAt: new Date('2026-08-30T00:00:00.000Z'),
          skill: { slug: 'smoke-skill', name: 'Smoke Skill', description: 'Smoke verification skill' }
        }]
      }
    }
    const controller = new SkillsController(prisma as any, {} as any)

    const response = jsonSafe(await controller.catalog({
      principal: { organizationId: '20000000-0000-4000-8000-000000000001' }
    })) as Array<{ sizeBytes: unknown }>

    expect(response[0].sizeBytes).toBe(1024)
  })
})
