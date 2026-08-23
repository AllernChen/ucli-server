import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { ChannelsService } from './channels.service.js'
import { CatalogLifecycle, ChannelListQueryDto, CreateChannelDto, UpdateChannelDto } from './catalog.dto.js'

@ApiTags('admin/channels') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/admin/channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}
  @Get() list(@Query() query: ChannelListQueryDto) { return this.channels.list(query) }
  @Get(':id') detail(@Param('id', UuidPipe) id: string, @Query('lifecycle') lifecycle?: CatalogLifecycle) {
    return this.channels.detail(id, lifecycle)
  }
  @Post() create(@Body() body: CreateChannelDto) { return this.channels.create(body) }
  @Post(':id/keys') addKey(@Param('id', UuidPipe) id: string, @Body() body: any) { return this.channels.addKey(id, body) }
  @Patch(':id/enabled') enabled(@Param('id', UuidPipe) id: string, @Body() body: any) { return this.channels.setEnabled(id, Boolean(body.enabled)) }
  @Post(':id/test') test(@Param('id', UuidPipe) id: string) { return this.channels.test(id) }
  @Post(':id/discover-models') discover(@Param('id', UuidPipe) id: string) { return this.channels.discoverModels(id) }
  @Patch(':id') update(@Param('id', UuidPipe) id: string, @Body() body: UpdateChannelDto) { return this.channels.update(id, body) }
  @Patch(':id/keys/:keyId') updateKey(@Param('id', UuidPipe) id: string, @Param('keyId', UuidPipe) keyId: string, @Body() body: any) {
    return this.channels.updateKey(id, keyId, body)
  }
  @Delete(':id/keys/:keyId') archiveKey(@Param('id', UuidPipe) id: string, @Param('keyId', UuidPipe) keyId: string) {
    return this.channels.archiveKey(id, keyId)
  }
  @Post(':id/keys/:keyId/restore') restoreKey(@Param('id', UuidPipe) id: string, @Param('keyId', UuidPipe) keyId: string) {
    return this.channels.restoreKey(id, keyId)
  }
  @Delete(':id') archive(@Param('id', UuidPipe) id: string) { return this.channels.archive(id) }
  @Post(':id/restore') restore(@Param('id', UuidPipe) id: string) { return this.channels.restore(id) }
}
