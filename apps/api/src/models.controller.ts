import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import {
  ArchivePublicModelAbilityDto, CreateModelPriceDto, CreatePublicModelAbilityDto, CreatePublicModelDto,
  LifecyclePageQueryDto, UpdateModelPriceDto, UpdatePublicModelDto
} from './catalog.dto.js'
import { ModelsService } from './models.service.js'

@ApiTags('admin/models') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/admin/models')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get() list(@Query() query: LifecyclePageQueryDto) { return this.models.list(query.lifecycle) }
  @Post() create(@Body() body: CreatePublicModelDto) { return this.models.create(body) }
  @Patch(':id') update(@Param('id') id: string, @Body() body: UpdatePublicModelDto) { return this.models.update(id, body) }
  @Delete(':id') archive(@Param('id') id: string) { return this.models.archive(id) }
  @Post(':id/restore') restore(@Param('id') id: string) { return this.models.restore(id) }
  @Post(':id/publish') publish(@Param('id') id: string) { return this.models.publish(id) }
  @Post(':id/publish-check') publishCheck(@Param('id') id: string) { return this.models.publishCheck(id) }
  @Post(':id/unpublish') unpublish(@Param('id') id: string) { return this.models.unpublish(id) }

  @Post(':id/abilities') ability(@Param('id') id: string, @Body() body: CreatePublicModelAbilityDto) {
    return this.models.createAbility(id, body)
  }
  @Delete(':id/abilities') removeAbility(@Param('id') id: string, @Body() body: ArchivePublicModelAbilityDto) {
    return this.models.archiveAbility(id, body)
  }

  @Post(':id/prices') price(@Param('id') id: string, @Body() body: CreateModelPriceDto) {
    return this.models.createPrice(id, body)
  }
  @Patch(':id/prices/:priceId') updatePrice(
    @Param('id') id: string, @Param('priceId') priceId: string, @Body() body: UpdateModelPriceDto
  ) { return this.models.updatePrice(id, priceId, body) }
  @Delete(':id/prices/:priceId') archivePrice(@Param('id') id: string, @Param('priceId') priceId: string) {
    return this.models.archivePrice(id, priceId)
  }
  @Post(':id/prices/:priceId/restore') restorePrice(@Param('id') id: string, @Param('priceId') priceId: string) {
    return this.models.restorePrice(id, priceId)
  }
  @Post(':id/prices/:priceId/enable') enablePrice(@Param('id') id: string, @Param('priceId') priceId: string) {
    return this.models.setPriceEnabled(id, priceId, true)
  }
  @Post(':id/prices/:priceId/disable') disablePrice(@Param('id') id: string, @Param('priceId') priceId: string) {
    return this.models.setPriceEnabled(id, priceId, false)
  }
}
