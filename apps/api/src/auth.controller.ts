import { Body, Controller, Headers, Post, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { AuthService } from './auth.service.js'

@ApiTags('auth')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @ApiHeader({ name: 'X-UCLI-Setup-Secret', required: true })
  @Post('setup') setup(@Body() body: any, @Headers('x-ucli-setup-secret') secret?: string) { return this.auth.setup(body, secret) }
  @Post('login') login(@Body() body: any) { return this.auth.login(body) }
  @Post('invitations/accept') accept(@Body() body: any) { return this.auth.acceptInvitation(body) }
  @Post('device/code') deviceCode(@Body() body: any) { return this.auth.startDevice(String(body.deviceName || 'UCLI')) }
  @Post('device/token') deviceToken(@Body() body: any) { return this.auth.pollDevice(String(body.deviceCode || '')) }
  @Post('token/refresh') refresh(@Body() body: any) { return this.auth.refresh(String(body.refreshToken || '')) }
  @ApiBearerAuth() @UseGuards(AuthGuard) @Post('device/approve')
  approve(@Body() body: any, @Req() request: any) { return this.auth.approveDevice(String(body.userCode || ''), request.principal.sub) }
}
