import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { ChannelModelsService } from './channel-models.service.js'
import { BatchTestChannelModelsDto, BindChannelModelDto, CreateChannelModelDto, CreateCostRuleDto, LifecyclePageQueryDto, PageQueryDto, PreviewCostRuleDto, UpdateChannelModelDto, UpdateCostRuleDto } from './catalog.dto.js'
import { ModelBindingService } from './model-binding.service.js'
import { ModelTestingService } from './model-testing.service.js'

@ApiTags('admin/channel-models') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/admin')
export class ChannelModelsController {
  constructor(
    private readonly channelModels: ChannelModelsService,
    private readonly modelTesting: ModelTestingService,
    private readonly modelBinding: ModelBindingService
  ) {}

  @Get('channels/:channelId/models')
  list(@Param('channelId', UuidPipe) channelId: string, @Query() query: LifecyclePageQueryDto) {
    return this.channelModels.listByChannel(channelId, query)
  }

  @Post('channels/:channelId/models')
  create(@Param('channelId', UuidPipe) channelId: string, @Body() body: CreateChannelModelDto) {
    return this.channelModels.create(channelId, body)
  }

  @Post('channels/:channelId/models/bind')
  bind(@Param('channelId', UuidPipe) channelId: string, @Body() body: BindChannelModelDto) {
    return this.modelBinding.bind(channelId, body)
  }

  @Patch('channel-models/:id')
  update(@Param('id', UuidPipe) id: string, @Body() body: UpdateChannelModelDto) {
    return this.channelModels.update(id, body)
  }

  @Patch('channel-models/:id/bind')
  rebind(@Param('id', UuidPipe) id: string, @Body() body: BindChannelModelDto) {
    return this.modelBinding.rebind(id, body)
  }

  @Delete('channel-models/:id')
  archive(@Param('id', UuidPipe) id: string) { return this.channelModels.archive(id) }

  @Post('channel-models/:id/restore')
  restore(@Param('id', UuidPipe) id: string) { return this.channelModels.restore(id) }

  @Get('channel-models/:id/cost-rules')
  costs(@Param('id', UuidPipe) id: string, @Query() query: LifecyclePageQueryDto) {
    return this.channelModels.listCostRules(id, query.lifecycle)
  }

  @Post('channel-models/:id/cost-rules')
  createCost(@Param('id', UuidPipe) id: string, @Body() body: CreateCostRuleDto) {
    return this.channelModels.createCostRule(id, body)
  }

  @Post('channel-models/:id/cost-rules/preview')
  previewCost(@Param('id', UuidPipe) id: string, @Body() body: PreviewCostRuleDto) {
    return this.channelModels.previewCostRule(id, body)
  }

  @Patch('channel-model-cost-rules/:id')
  updateCost(@Param('id', UuidPipe) id: string, @Body() body: UpdateCostRuleDto) {
    return this.channelModels.updateCostRule(id, body)
  }

  @Delete('channel-model-cost-rules/:id')
  archiveCost(@Param('id', UuidPipe) id: string) { return this.channelModels.archiveCostRule(id) }

  @Post('channel-model-cost-rules/:id/restore')
  restoreCost(@Param('id', UuidPipe) id: string) { return this.channelModels.restoreCostRule(id) }

  @Get('channel-models/:id/probes')
  probes(@Param('id', UuidPipe) id: string, @Query() query: PageQueryDto) {
    return this.channelModels.listProbes(id, query)
  }

  @Post('channel-models/:id/test')
  test(@Param('id', UuidPipe) id: string, @Req() request: any) {
    return this.modelTesting.testChannelModel(id, {}, request.principal.sub, 'MANUAL')
  }

  @Post('channels/:channelId/models/test-batch')
  testBatch(@Param('channelId', UuidPipe) channelId: string, @Body() body: BatchTestChannelModelsDto, @Req() request: any) {
    return this.modelTesting.testChannelModels(channelId, body.channelModelIds, request.principal.sub)
  }
}
