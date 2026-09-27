import 'reflect-metadata'
import { BadRequestException, ValidationPipe } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { OrgUnitPageQueryDto } from '../../apps/api/src/org-units.dto.js'

// Task 4 审查发现：集成测试直构数组绕过了 kind 的 @Transform 逗号转换链。
// 若该转换被移除，集成测试依旧全绿，但 HTTP 查询链路会把 kind 当作整串
// 字符串送进 @IsArray 校验而全部 400 —— 本单测锁住转换链不被静默破坏。
describe('org-unit kind query comma transform', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })
  const metadata = { type: 'query' as const, metatype: OrgUnitPageQueryDto }

  it('splits comma-separated kinds, trims blanks and drops empty entries', async () => {
    await expect(pipe.transform({ status: 'active', kind: 'REGION, EXECUTIVE' }, metadata))
      .resolves.toMatchObject({ kind: ['REGION', 'EXECUTIVE'] })
    await expect(pipe.transform({ status: 'active', kind: 'REGION,' }, metadata))
      .resolves.toMatchObject({ kind: ['REGION'] })
  })

  it('treats an empty kind as no filter', async () => {
    await expect(pipe.transform({ status: 'active', kind: '' }, metadata))
      .resolves.toMatchObject({ kind: [] })
  })

  it('rejects duplicated kinds after the transform', async () => {
    await expect(pipe.transform({ status: 'active', kind: 'REGION,REGION' }, metadata))
      .rejects.toBeInstanceOf(BadRequestException)
  })
})
