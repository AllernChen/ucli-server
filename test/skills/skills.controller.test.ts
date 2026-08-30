import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { SkillsController } from '../../apps/api/src/skills.controller.js'
import { jsonSafe } from '../../packages/http/src/json.js'

describe('skills catalog controller', () => {
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
