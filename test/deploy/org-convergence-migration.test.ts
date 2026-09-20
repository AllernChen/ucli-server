import { describe, expect, it } from 'vitest'
import { expectedOrganizationSnapshot } from '../../scripts/verify-org-convergence.mjs'

describe('organization convergence migration verifier', () => {
  it('builds the required production snapshot', () => {
    expect(expectedOrganizationSnapshot({
      executiveMembers: ['李健', '罗晰伊', '王宇'],
      functionalOrganizations: [
        { name: '研发部', memberCount: 4 },
        { name: '工程部', memberCount: 4 }
      ],
      regions: [
        '广东-市局区域', '广东-省厅区域', '广东-东莞区域', '广东-花都区域',
        '贵州区域', '江苏-苏州区域', '北京-GAB区域'
      ],
      departmentProjects: ['公司经营层-部门预算', '研发部-部门预算', '工程部-部门预算']
    })).toEqual({
      activeDuplicateMembers: 0,
      executiveCount: 1,
      functionalCount: 2,
      regionCount: 7,
      legacyProjectCount: expect.any(Number),
      departmentProjectCount: 3
    })
  })

  it('rejects duplicate or incomplete target names', () => {
    expect(() => expectedOrganizationSnapshot({
      executiveMembers: ['李健', '罗晰伊'],
      functionalOrganizations: [{ name: '研发部', memberCount: 4 }],
      regions: ['广东-市局区域'],
      departmentProjects: ['研发部-部门预算']
    })).toThrow('organization convergence target snapshot is invalid')
  })
})
