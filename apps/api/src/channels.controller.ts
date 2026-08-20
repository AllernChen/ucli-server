import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { ChannelsService } from './channels.service.js'
import { ChannelListQueryDto, CreateChannelDto, UpdateChannelDto } from './catalog.dto.js'

@ApiTags('admin/channels') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/admin/channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}
  @Get() list(@Query() query: ChannelListQueryDto) { return this.channels.list(query) }
  @Get(':id') detail(@Param('id', UuidPipe) id: string) { return this.channels.detail(id) }
  @Post() create(@Body() body: CreateChannelDto) { return this.channels.create(body) }
  @Post(':id/keys') addKey(@Param('id', UuidPipe) id: string, @Body() body: any) { return this.channels.addKey(id, body) }
  @Patch(':id/enabled') enabled(@Param('id', UuidPipe) id: string, @Body() body: any) { return this.channels.setEnabled(id, Boolean(body.enabled)) }
  @Post(':id/test') test(@Param('id', UuidPipe) id: string) { return this.channels.test(id) }
  @Post(':id/discover-models') discover(@Param('id', UuidPipe) id: string) { return this.channels.discoverModels(id) }
  @Patch(':id') update(@Param('id', UuidPipe) id: string, @Body() body: UpdateChannelDto) { return this.channels.update(id, body) }
  @Patch(':id/keys/:keyId') updateKey(@Param('id', UuidPipe) id: string, @Param('keyId', UuidPipe) keyId: string, @Body() body: any) {
    return this.channels.updateKey(id, keyId, body)
  }
}
