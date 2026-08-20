import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { ChannelModelsService } from './channel-models.service.js'

@ApiTags('admin/models') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/admin/models')
export class ModelsController {
  constructor(private readonly prisma: PrismaService, private readonly channelModels: ChannelModelsService) {}
  @Get() async list() {
    const models = await this.prisma.publicModel.findMany({ include: { channelModels: true, prices: true } })
    return models.map(({ channelModels, ...model }) => ({ ...model, abilities: channelModels }))
  }
  @Post() create(@Body() body: any) { return this.prisma.publicModel.create({ data: {
    id: body.id, displayName: body.displayName, contextSize: body.contextSize || null, enabled: false
  } }) }
  @Post(':id/abilities') ability(@Param('id') id: string, @Body() body: any) {
    return this.prisma.channelModel.create({ data: {
      publicModelId: id, channelId: body.channelId, upstreamModel: body.upstreamModel,
      protocol: body.protocol, supportsStream: body.supportsStream !== false, supportsTools: body.supportsTools !== false
    } })
  }
  @Post(':id/prices') price(@Param('id') id: string, @Body() body: any) {
    return this.prisma.modelPriceVersion.create({ data: {
      publicModelId: id, inputPerMillion: body.inputPerMillion, outputPerMillion: body.outputPerMillion,
      cachedPerMillion: body.cachedPerMillion || 0, reasoningPerMillion: body.reasoningPerMillion || 0,
      validFrom: new Date(body.validFrom || Date.now())
    } })
  }
  @Post(':id/publish') async publish(@Param('id') id: string) {
    const check = await this.channelModels.publishCheck(id)
    if (!check.ready) throw new BadRequestException({ message: 'Model is not ready to publish', blockers: check.blockers })
    return this.prisma.publicModel.update({ where: { id }, data: { enabled: true } })
  }
  @Post(':id/publish-check') publishCheck(@Param('id') id: string) { return this.channelModels.publishCheck(id) }
  @Patch(':id') update(@Param('id') id: string, @Body() body: any) {
    return this.prisma.publicModel.update({ where: { id }, data: {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.contextSize !== undefined ? { contextSize: body.contextSize || null } : {})
    } })
  }
  @Post(':id/unpublish') unpublish(@Param('id') id: string) {
    return this.prisma.publicModel.update({ where: { id }, data: { enabled: false } })
  }
  @Delete(':id/abilities') removeAbility(@Param('id') id: string, @Body() body: any) {
    return this.prisma.channelModel.delete({ where: { channelId_publicModelId_protocol: {
      channelId: body.channelId, publicModelId: id, protocol: body.protocol
    } } })
  }
  @Delete(':id/prices/:priceId') removePrice(@Param('id') id: string, @Param('priceId') priceId: string) {
    return this.prisma.modelPriceVersion.deleteMany({ where: { id: priceId, publicModelId: id } })
  }
}
