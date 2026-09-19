import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles, type AuthPrincipal } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { AddProjectMemberDto, CreateProjectDto, ProjectPageQueryDto, SetProjectMemberRoleDto, UpdateProjectDto } from './projects.dto.js'
import { ProjectsService } from './projects.service.js'

type AdminRequest = { principal: AuthPrincipal }

@ApiTags('admin/projects') @ApiBearerAuth() @UseGuards(AuthGuard)
@Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Controller('api/v1/admin/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get() list(@Req() req: AdminRequest, @Query() query: ProjectPageQueryDto) { return this.projects.list(req.principal, query) }
  @Post() create(@Req() req: AdminRequest, @Body() body: CreateProjectDto) { return this.projects.create(req.principal, body) }
  @Get(':id') detail(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.projects.detail(req.principal, id) }
  @Patch(':id') update(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Body() body: UpdateProjectDto) { return this.projects.update(req.principal, id, body) }
  @Post(':id/disable') disable(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.projects.setStatus(req.principal, id, 'SUSPENDED') }
  @Post(':id/enable') enable(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.projects.setStatus(req.principal, id, 'ACTIVE') }
  @Post(':id/archive') archive(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.projects.setStatus(req.principal, id, 'ARCHIVED') }
  @Get(':id/members') members(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string) { return this.projects.members(req.principal, id) }
  @Post(':id/members') addMember(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Body() body: AddProjectMemberDto) { return this.projects.addMember(req.principal, id, body) }
  @Patch(':id/members/:accountId') setMemberRole(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Param('accountId', UuidPipe) accountId: string, @Body() body: SetProjectMemberRoleDto) { return this.projects.setMemberRole(req.principal, id, accountId, body.role) }
  @Delete(':id/members/:accountId') removeMember(@Req() req: AdminRequest, @Param('id', UuidPipe) id: string, @Param('accountId', UuidPipe) accountId: string) { return this.projects.removeMember(req.principal, id, accountId) }
}
