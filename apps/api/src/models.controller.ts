import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { PrismaService } from '../../../packages/database/src/prisma.service.js'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'

@ApiTags('admin/models') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/admin/models')
export class ModelsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.publicModel.findMany({ include: { abilities: true, prices: true } }) }
  @Post() create(@Body() body: any) { return this.prisma.publicModel.create({ data: {
    id: body.id, displayName: body.displayName, contextSize: body.contextSize || null, enabled: false
  } }) }
  @Post(':id/abilities') ability(@Param('id') id: string, @Body() body: any) {
    return this.prisma.channelAbility.create({ data: {
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
    const healthy = await this.prisma.channelAbility.count({ where: {
      publicModelId: id, enabled: true, channel: { enabled: true, health: { in: ['HEALTHY', 'DEGRADED'] } }
    } })
    if (!healthy) throw new BadRequestException('Model has no healthy channel ability')
    return this.prisma.publicModel.update({ where: { id }, data: { enabled: true } })
  }
}
