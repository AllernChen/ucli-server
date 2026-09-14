import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { describe, expect, it } from 'vitest'
import { AddGroupMemberDto, CreateUsageGroupDto, ReplaceGroupModelsDto, UpdateUsageGroupDto, UsageGroupPageQueryDto } from '../../apps/api/src/usage-groups.dto.js'
import { UsageGroupsController } from '../../apps/api/src/usage-groups.controller.js'
import { ROLES_KEY } from '../../packages/security/src/auth.js'

describe('usage group API boundaries', () => {
  it('restricts administration and rejects invalid metadata, ids and pagination', () => {
    expect(Reflect.getMetadata(ROLES_KEY, UsageGroupsController)).toEqual(['PLATFORM_ADMIN', 'ORG_ADMIN'])
    for (const [dto, body] of [
      [CreateUsageGroupDto, { name: ' ', type: 'PROJECT' }],
      [CreateUsageGroupDto, { name: 'Test', type: 'UNKNOWN' }],
      [UpdateUsageGroupDto, { name: null }],
      [UpdateUsageGroupDto, { description: 'x'.repeat(2001) }],
      [AddGroupMemberDto, { accountId: 'foreign-input' }],
      [ReplaceGroupModelsDto, { publicModelIds: ['same', 'same'] }],
      [UsageGroupPageQueryDto, { limit: 201 }],
      [UsageGroupPageQueryDto, { status: 'invalid' }]
    ] as const) {
      expect(validateSync(plainToInstance(dto as new () => object, body)).length).toBeGreaterThan(0)
    }
    expect(validateSync(plainToInstance(ReplaceGroupModelsDto, { publicModelIds: [] }))).toEqual([])
  })
})
