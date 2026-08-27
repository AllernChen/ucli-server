import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { CreateDeviceGrantDto, CreateDeviceGrantLinkDto, DeviceGrantPageQueryDto, UpdateDeviceGrantDto } from './device-grants.dto.js'
import { DeviceGrantLinksService } from './device-grant-links.service.js'
import { DeviceGrantsService } from './device-grants.service.js'

@ApiTags('admin/device-grants') @ApiBearerAuth() @UseGuards(AuthGuard)
@Roles('PLATFORM_ADMIN', 'ORG_ADMIN') @Controller('api/v1/admin')
export class DeviceGrantsController {
  constructor(private readonly grants: DeviceGrantsService, private readonly links: DeviceGrantLinksService) {}

  @Post('users/:userId/device-grants')
  create(@Req() req: any, @Param('userId', UuidPipe) userId: string, @Body() body: CreateDeviceGrantDto) {
    return this.grants.create(req.principal.organizationId, req.principal.sub, userId, body)
  }

  @Get('device-grants')
  list(@Req() req: any, @Query() query: DeviceGrantPageQueryDto) {
    return this.grants.listGrouped(req.principal.organizationId, query)
  }

  @Patch('device-grants/:id')
  update(@Req() req: any, @Param('id', UuidPipe) id: string, @Body() body: UpdateDeviceGrantDto) {
    return this.grants.updateExpiration(req.principal.organizationId, req.principal.sub, id, body.expiresAt)
  }

  @Post('device-grants/:id/disable')
  disable(@Req() req: any, @Param('id', UuidPipe) id: string) {
    return this.grants.disable(req.principal.organizationId, req.principal.sub, id)
  }

  @Post('device-grants/:id/enable')
  enable(@Req() req: any, @Param('id', UuidPipe) id: string) {
    return this.grants.enable(req.principal.organizationId, req.principal.sub, id)
  }

  @Delete('device-grants/:id')
  delete(@Req() req: any, @Param('id', UuidPipe) id: string) {
    return this.grants.delete(req.principal.organizationId, req.principal.sub, id)
  }

  @Get('device-grants/:id/link')
  @Header('Cache-Control', 'no-store')
  viewLink(@Req() req: any, @Param('id', UuidPipe) id: string) {
    return this.links.viewCurrent(req.principal.organizationId, req.principal.sub, id)
  }

  @Post('device-grants/:id/links')
  @Header('Cache-Control', 'no-store')
  regenerateLink(@Req() req: any, @Param('id', UuidPipe) id: string, @Body() body: CreateDeviceGrantLinkDto) {
    return this.links.regenerate(req.principal.organizationId, req.principal.sub, id, body)
  }
}
