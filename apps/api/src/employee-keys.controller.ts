import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles, type AuthPrincipal } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { PageQueryDto } from './catalog.dto.js'
import { CreateEmployeeKeyDto, UpdateEmployeeKeyDto } from './employee-keys.dto.js'
import { EmployeeKeysService } from './employee-keys.service.js'

type AuthRequest = { principal: AuthPrincipal }

@ApiTags('employee-api-keys') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1')
export class EmployeeKeysController {
  constructor(private readonly keys: EmployeeKeysService) {}
  @Get('admin/users/:accountId/usage-groups') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Header('Cache-Control', 'no-store')
  groups(@Req() req: AuthRequest, @Param('accountId', UuidPipe) accountId: string) { return this.keys.groups(req.principal, accountId) }
  @Get('me/usage-groups') @Header('Cache-Control', 'no-store')
  myGroups(@Req() req: AuthRequest) { return this.keys.groups(req.principal) }
  @Get('admin/users/:accountId/api-keys') @Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthRequest, @Param('accountId', UuidPipe) accountId: string, @Query() query: PageQueryDto) { return this.keys.list(req.principal, accountId, query) }
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
  mine(@Req() req: AuthRequest, @Query() query: PageQueryDto) { return this.keys.listMine(req.principal, query) }
  @Post('me/api-keys/:id/revoke')
  revokeMine(@Req() req: AuthRequest, @Param('id', UuidPipe) id: string) { return this.keys.revoke(req.principal, id, true) }
}
