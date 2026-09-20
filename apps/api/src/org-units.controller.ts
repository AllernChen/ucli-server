import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles, type AuthPrincipal } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { PageQueryDto } from './catalog.dto.js'
import { AddOrgUnitMemberDto, CreateOrgUnitDto, OrgUnitPageQueryDto, ReplaceOrgUnitModelsDto, UpdateOrgUnitDto } from './org-units.dto.js'
import { OrgUnitsService } from './org-units.service.js'

type AdminRequest = { principal: AuthPrincipal }

@ApiTags('admin/org-units') @ApiBearerAuth() @UseGuards(AuthGuard)
@Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Controller('api/v1/admin/org-units')
export class OrgUnitsController {
  constructor(private readonly organizations: OrgUnitsService) {}

  @Get() list(@Req() req: AdminRequest, @Query() query: OrgUnitPageQueryDto) {
    return this.organizations.list(req.principal.organizationId, query)
  }
  @Post() create(@Req() req: AdminRequest, @Body() body: CreateOrgUnitDto) { return this.organizations.create(req.principal, body) }
  @Get(':id') detail(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) {
    return this.organizations.detail(req.principal.organizationId, id)
  }
  @Patch(':id') update(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Body() body: UpdateOrgUnitDto) {
    return this.organizations.update(req.principal, id, body)
  }
  @Get(':id/members') members(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Query() query: PageQueryDto) {
    return this.organizations.members(req.principal.organizationId, id, query)
  }
  @Get(':id/projects') projects(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) {
    return this.organizations.projects(req.principal.organizationId, id)
  }
  @Get(':id/model-access') models(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) {
    return this.organizations.modelAccess(req.principal.organizationId, id)
  }
  @Put(':id/model-access') replaceModels(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Body() body: ReplaceOrgUnitModelsDto) {
    return this.organizations.replaceModels(req.principal, id, body.publicModelIds)
  }
}
