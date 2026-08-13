import { Body, Controller, Get, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { GatewayService } from './gateway.service.js'

@ApiTags('model-gateway') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller()
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}
  @Get('v1/models') async models(@Req() request: any) {
    if (!request.principal.deviceId) throw new UnauthorizedException('A UCLI device token is required')
    const models = await this.gateway.models({ organizationId: request.principal.organizationId,
      accountId: request.principal.sub, role: request.principal.role })
    return { object: 'list', data: models.map(model => ({ id: model.id, object: 'model', owned_by: 'ucli' })) }
  }
  @Post('v1/responses') responses(@Body() body: any, @Req() request: any, @Res() response: Response) {
    if (!request.principal.deviceId) throw new UnauthorizedException('A UCLI device token is required')
    return this.gateway.relay({ protocol: 'openai_responses', body, headers: request.headers, principal: request.principal, response })
  }
  @Post('v1/chat/completions') chat(@Body() body: any, @Req() request: any, @Res() response: Response) {
    if (!request.principal.deviceId) throw new UnauthorizedException('A UCLI device token is required')
    return this.gateway.relay({ protocol: 'openai_chat', body, headers: request.headers, principal: request.principal, response })
  }
  @Post('anthropic/v1/messages') messages(@Body() body: any, @Req() request: any, @Res() response: Response) {
    if (!request.principal.deviceId) throw new UnauthorizedException('A UCLI device token is required')
    return this.gateway.relay({ protocol: 'anthropic_messages', body, headers: request.headers, principal: request.principal, response })
  }
}
