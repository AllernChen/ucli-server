import { Body, Controller, Get, Header, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { GatewayAuthGuard, type GatewayIdentity } from '../../../packages/security/src/gateway-auth.js'
import { GatewayService } from './gateway.service.js'

@ApiTags('model-gateway') @ApiBearerAuth() @UseGuards(GatewayAuthGuard) @Controller()
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}
  private identity(request: any): GatewayIdentity {
    const principal = request.principal as GatewayIdentity
    if (!principal || !((principal.credentialType === 'DEVICE' && principal.deviceId) ||
      (principal.credentialType === 'API_KEY' && principal.apiKeyId && principal.groupId))) {
      throw new UnauthorizedException('A device token or employee API key is required')
    }
    return principal
  }
  @Get('v1/models') @Header('Cache-Control', 'no-store') async models(@Req() request: any) {
    const principal = this.identity(request)
    const models = await this.gateway.models({ organizationId: principal.organizationId,
      accountId: principal.sub, role: principal.role, groupId: principal.groupId })
    return { object: 'list', data: models.map(model => ({
      id: model.id, object: 'model', owned_by: 'ucli',
      display_name: model.displayName, context_size: model.contextSize, protocols: model.protocols
    })) }
  }
  @Get('anthropic/v1/models') @Header('Cache-Control', 'no-store') async anthropicModels(@Req() request: any) {
    const principal = this.identity(request)
    const models = await this.gateway.models({ organizationId: principal.organizationId,
      accountId: principal.sub, role: principal.role, groupId: principal.groupId }, 'anthropic_messages')
    return { data: models.map(model => ({ id: model.id, display_name: model.displayName })), has_more: false }
  }
  @Post('v1/responses') responses(@Body() body: any, @Req() request: any, @Res() response: Response) {
    return this.gateway.relay({ protocol: 'openai_responses', body, headers: request.headers, principal: this.identity(request), response })
  }
  @Post('v1/chat/completions') chat(@Body() body: any, @Req() request: any, @Res() response: Response) {
    return this.gateway.relay({ protocol: 'openai_chat', body, headers: request.headers, principal: this.identity(request), response })
  }
  @Post('anthropic/v1/messages') messages(@Body() body: any, @Req() request: any, @Res() response: Response) {
    return this.gateway.relay({ protocol: 'anthropic_messages', body, headers: request.headers, principal: this.identity(request), response })
  }
}
