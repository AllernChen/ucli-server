import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles, type AuthPrincipal } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { PageQueryDto } from './catalog.dto.js'
import { AddGroupMemberDto, BudgetAdjustmentDto, BudgetApplicationDecisionDto, BudgetConfigDto, BudgetReconcileDto, CreateBudgetApplicationDto, CreateUsageGroupDto, GroupModelOptionsDto, ReplaceGroupModelsDto, UpdateUsageGroupDto, UsageGroupPageQueryDto } from './usage-groups.dto.js'
import { UsageGroupsService } from './usage-groups.service.js'
import { GroupBudgetService } from '../../../packages/quota/src/group-budget.service.js'

type AdminRequest = { principal: AuthPrincipal }

@ApiTags('admin/usage-groups') @ApiBearerAuth() @UseGuards(AuthGuard)
@Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Controller('api/v1/admin/usage-groups')
export class UsageGroupsController {
  constructor(private readonly groups: UsageGroupsService, private readonly budget: GroupBudgetService) {}
  @Get() list(@Req() req: AdminRequest, @Query() query: UsageGroupPageQueryDto) { return this.groups.list(req.principal.organizationId, query) }
  @Post() create(@Req() req: AdminRequest, @Body() body: CreateUsageGroupDto) { return this.groups.create(req.principal, body) }
  @Get(':id') detail(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.groups.detail(req.principal.organizationId, id) }
  @Get(':id/projects') projects(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.groups.projects(req.principal.organizationId, id) }
  @Patch(':id') update(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Body() body: UpdateUsageGroupDto) { return this.groups.update(req.principal, id, body) }
  @Delete(':id') archive(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.groups.archive(req.principal, id) }
  @Post(':id/enable') enable(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.groups.setEnabled(req.principal, id, true) }
  @Post(':id/disable') disable(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.groups.setEnabled(req.principal, id, false) }
  @Get(':id/members') members(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Query() query: PageQueryDto) { return this.groups.members(req.principal.organizationId, id, query) }
  @Post(':id/members') addMember(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Body() body: AddGroupMemberDto) { return this.groups.addMember(req.principal, id, body.accountId) }
  @Delete(':id/members/:accountId') removeMember(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Param('accountId', UuidPipe) accountId: string) { return this.groups.removeMember(req.principal, id, accountId) }
  @Post(':id/members/:accountId/leader') setLeader(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Param('accountId', UuidPipe) accountId: string) { return this.groups.setLeader(req.principal, id, accountId, true) }
  @Delete(':id/members/:accountId/leader') unsetLeader(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Param('accountId', UuidPipe) accountId: string) { return this.groups.setLeader(req.principal, id, accountId, false) }
  @Get(':id/models') models(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.groups.models(req.principal.organizationId, id) }
  @Get(':id/model-options') modelOptions(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Query() query: GroupModelOptionsDto) { return this.groups.modelOptions(req.principal.organizationId, id, query.accountId) }
  @Put(':id/models') replaceModels(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Body() body: ReplaceGroupModelsDto) { return this.groups.replaceModels(req.principal, id, body.publicModelIds) }
  @Get(':id/budget') budgetSummary(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.budget.summary(req.principal, id) }
  @Patch(':id/budget-config') budgetConfig(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Body() body: BudgetConfigDto) { return this.budget.configure(req.principal, id, body) }
  @Post(':id/budget-adjustments') budgetAdjust(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Body() body: BudgetAdjustmentDto) { return this.budget.adjust(req.principal, id, body) }
  @Get(':id/budget-entries') budgetEntries(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Query() query: PageQueryDto) { return this.budget.entries(req.principal, id, query) }
  @Post(':id/budget-entries/:entryId/reconcile') budgetReconcile(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Param('entryId', UuidPipe) entryId: string, @Body() body: BudgetReconcileDto) { return this.budget.reconcile(req.principal, id, entryId, body) }
  @Get(':id/budget-applications') budgetApplications(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Query() query: PageQueryDto) { return this.groups.applications(req.principal.organizationId, id, query) }
  @Post(':id/budget-applications') createBudgetApplication(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Body() body: CreateBudgetApplicationDto) { return this.groups.createApplication(req.principal, id, body) }
  @Post(':id/budget-applications/:appId/decision') rejectBudgetApplication(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Param('appId', UuidPipe) appId: string, @Body() body: BudgetApplicationDecisionDto) { return this.groups.rejectApplication(req.principal, id, appId, body.note) }
}
