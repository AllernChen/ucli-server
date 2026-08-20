import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { ChannelModelsService } from './channel-models.service.js'
import { CreateChannelModelDto, CreateCostRuleDto, PageQueryDto, UpdateChannelModelDto, UpdateCostRuleDto } from './catalog.dto.js'

@ApiTags('admin/channel-models') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/admin')
export class ChannelModelsController {
  constructor(private readonly channelModels: ChannelModelsService) {}

  @Get('channels/:channelId/models')
  list(@Param('channelId', UuidPipe) channelId: string, @Query() query: PageQueryDto) {
    return this.channelModels.listByChannel(channelId, query)
  }

  @Post('channels/:channelId/models')
  create(@Param('channelId', UuidPipe) channelId: string, @Body() body: CreateChannelModelDto) {
    return this.channelModels.create(channelId, body)
  }

  @Patch('channel-models/:id')
  update(@Param('id', UuidPipe) id: string, @Body() body: UpdateChannelModelDto) {
    return this.channelModels.update(id, body)
  }

  @Delete('channel-models/:id')
  remove(@Param('id', UuidPipe) id: string) { return this.channelModels.remove(id) }

  @Get('channel-models/:id/cost-rules')
  costs(@Param('id', UuidPipe) id: string) { return this.channelModels.listCostRules(id) }

  @Post('channel-models/:id/cost-rules')
  createCost(@Param('id', UuidPipe) id: string, @Body() body: CreateCostRuleDto) {
    return this.channelModels.createCostRule(id, body)
  }

  @Patch('channel-model-cost-rules/:id')
  updateCost(@Param('id', UuidPipe) id: string, @Body() body: UpdateCostRuleDto) {
    return this.channelModels.updateCostRule(id, body)
  }

  @Delete('channel-model-cost-rules/:id')
  removeCost(@Param('id', UuidPipe) id: string) { return this.channelModels.removeCostRule(id) }

  @Get('channel-models/:id/probes')
  probes(@Param('id', UuidPipe) id: string, @Query() query: PageQueryDto) {
    return this.channelModels.listProbes(id, query)
  }
}
