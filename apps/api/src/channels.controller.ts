import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { ChannelsService } from './channels.service.js'

@ApiTags('admin/channels') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/admin/channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}
  @Get() list() { return this.channels.list() }
  @Post() create(@Body() body: any) { return this.channels.create(body) }
  @Post(':id/keys') addKey(@Param('id', UuidPipe) id: string, @Body() body: any) { return this.channels.addKey(id, body) }
  @Patch(':id/enabled') enabled(@Param('id', UuidPipe) id: string, @Body() body: any) { return this.channels.setEnabled(id, Boolean(body.enabled)) }
  @Post(':id/test') test(@Param('id', UuidPipe) id: string) { return this.channels.test(id) }
}
