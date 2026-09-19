import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles, type AuthPrincipal } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { CreateEmployeeKeyDto, EmployeeKeyQueryDto, ProjectOptionQueryDto, RevealEmployeeKeyDto, UpdateEmployeeKeyDto } from './employee-keys.dto.js'
import { EmployeeKeysService } from './employee-keys.service.js'

type AuthRequest = { principal: AuthPrincipal }

@ApiTags('employee-api-keys') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1')
export class EmployeeKeysController {
  constructor(private readonly keys: EmployeeKeysService) {}
  @Get('admin/users/:accountId/usage-groups') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Header('Cache-Control', 'no-store')
  groups(@Req() req: AuthRequest, @Param('accountId', UuidPipe) accountId: string) { return this.keys.groups(req.principal, accountId) }
  @Get('me/usage-groups') @Header('Cache-Control', 'no-store')
  myGroups(@Req() req: AuthRequest) { return this.keys.groups(req.principal) }
  @Get('admin/users/:accountId/projects') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Header('Cache-Control', 'no-store')
  managedProjects(@Req() req: AuthRequest, @Param('accountId', UuidPipe) accountId: string, @Query() query: ProjectOptionQueryDto) { return this.keys.projectOptions(req.principal, accountId, query.regionId) }
  @Get('me/projects') @Header('Cache-Control', 'no-store')
  myProjects(@Req() req: AuthRequest, @Query() query: ProjectOptionQueryDto) { return this.keys.projectOptions(req.principal, undefined, query.regionId) }
  @Get('admin/users/:accountId/api-keys') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthRequest, @Param('accountId', UuidPipe) accountId: string, @Query() query: EmployeeKeyQueryDto) { return this.keys.list(req.principal, accountId, query) }
  @Get('admin/employee-api-keys') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Header('Cache-Control', 'no-store')
  listManaged(@Req() req: AuthRequest, @Query() query: EmployeeKeyQueryDto) { return this.keys.listManaged(req.principal, query) }
  @Post('admin/employee-api-keys/:id/reveal') @HttpCode(200) @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Header('Cache-Control', 'no-store')
  reveal(@Req() req: AuthRequest, @Param('id', UuidPipe) id: string, @Body() body: RevealEmployeeKeyDto) {
    return this.keys.reveal(req.principal, id, body)
  }
  @Post('admin/users/:accountId/api-keys') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthRequest, @Param('accountId', UuidPipe) accountId: string, @Body() body: CreateEmployeeKeyDto) { return this.keys.create(req.principal, accountId, body) }
  @Patch('admin/employee-api-keys/:id') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN')
  update(@Req() req: AuthRequest, @Param('id', UuidPipe) id: string, @Body() body: UpdateEmployeeKeyDto) { return this.keys.update(req.principal, id, body) }
  @Delete('admin/employee-api-keys/:id') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN')
  delete(@Req() req: AuthRequest, @Param('id', UuidPipe) id: string) { return this.keys.delete(req.principal, id) }
  @Post('admin/employee-api-keys/:id/enable') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN')
  enable(@Req() req: AuthRequest, @Param('id', UuidPipe) id: string) { return this.keys.setEnabled(req.principal, id, true) }
  @Post('admin/employee-api-keys/:id/disable') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN')
  disable(@Req() req: AuthRequest, @Param('id', UuidPipe) id: string) { return this.keys.setEnabled(req.principal, id, false) }
  @Post('admin/employee-api-keys/:id/revoke') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN')
  revoke(@Req() req: AuthRequest, @Param('id', UuidPipe) id: string) { return this.keys.revoke(req.principal, id) }
  @Get('me/api-keys') @Header('Cache-Control', 'no-store')
  mine(@Req() req: AuthRequest, @Query() query: EmployeeKeyQueryDto) { return this.keys.listMine(req.principal, query) }
  @Post('me/api-keys/:id/revoke')
  revokeMine(@Req() req: AuthRequest, @Param('id', UuidPipe) id: string) { return this.keys.revoke(req.principal, id, true) }
}
