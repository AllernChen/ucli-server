import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { CreateManagedUserDto, ManagedUserPageQueryDto, UpdateManagedUserRoleDto } from './device-grants.dto.js'
import { UsersService } from './users.service.js'

@ApiTags('admin/users') @ApiBearerAuth() @UseGuards(AuthGuard)
@Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Controller('api/v1/admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post() create(@Req() req: any, @Body() body: CreateManagedUserDto) { return this.users.create(req.principal.organizationId, body) }
  @Get() list(@Req() req: any, @Query() query: ManagedUserPageQueryDto) { return this.users.list(req.principal.organizationId, query) }
  @Get(':id') detail(@Req() req: any, @Param('id', UuidPipe) id: string) { return this.users.detail(req.principal.organizationId, id) }
  @Post(':id/disable') disable(@Req() req: any, @Param('id', UuidPipe) id: string) { return this.users.disable(req.principal.organizationId, id) }
  @Post(':id/enable') enable(@Req() req: any, @Param('id', UuidPipe) id: string) { return this.users.enable(req.principal.organizationId, id) }
  @Patch(':id/role') updateRole(@Req() req: any, @Param('id', UuidPipe) id: string, @Body() body: UpdateManagedUserRoleDto) {
    return this.users.updateRole(req.principal, id, body.role)
  }
}
