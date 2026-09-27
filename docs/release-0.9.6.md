# 0.9.6 — 跨组织单元抽调攻坚项目

状态：2026-09-27 发布准备完成，待部署公司服务器。

## 变更范围

- 项目挂靠放宽：手工建项目的挂靠校验从遗留 `type='REGION'` 切换到收敛后口径 `org_type IN ('REGION','EXECUTIVE')`，公司经营层（EXECUTIVE）可承载业务类攻坚项目；职能部门与遗留项目组仍不可挂靠。
- 跨组织单元抽调治理：向项目添加不属于挂靠单元的成员仅限平台管理员（403 文案 `Platform administrator required to add cross-unit members`）；单元内加人维持组织管理员权限；移除成员自动撤销项目 Key 的行为不变。
- 新增成员候选接口 `GET /api/v1/admin/projects/:id/member-candidates`：全组织活跃成员搜索（姓名/邮箱模糊匹配），返回归属组织单元（含 primary 标注）与 `inRegion` 标记，排除已有项目成员，确定性分页。
- 组织单元 `kind` 过滤支持逗号分隔多值（`kind=REGION,EXECUTIVE`），单值传参向后兼容。
- 管理端：新建项目挂靠选项纳入公司经营层；项目详情加成员改为跨单元可搜索选择器，候选人展示归属单元，组织管理员视角跨单元候选置灰并提示，候选加载带代次守卫。
- 零 schema 迁移：成员资格、员工 Key、项目预算、网关校验全部复用既有机制。

## 验证

- `npm run verify` 全绿：typecheck、935 项测试通过（含 PostgreSQL 集成测试）、覆盖率门槛、后端与管理端构建、license 检查。
- 全部 6 个实现任务经过规格符合性与代码质量两阶段审查，最终整体审查通过。
- 设计文档：`docs/superpowers/specs/2026-09-27-cross-unit-taskforce-projects-design.md`。

## 发布件

（部署打包后补充。）

## 公司部署记录

（部署完成后补充。）
