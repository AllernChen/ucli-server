import { Body, Controller, Get, Header, Headers, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { AuthService } from './auth.service.js'
import { DeviceGrantsService } from './device-grants.service.js'
import { InitialCredentialsDto } from './profile.dto.js'
import { PreviewDeviceGrantDto, RedeemDeviceGrantDto } from './device-grants.dto.js'
import { UpdateProfileDto } from './profile.dto.js'

@ApiTags('auth')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly grants: DeviceGrantsService) {}
  @ApiHeader({ name: 'X-UCLI-Setup-Secret', required: true })
  @Post('setup') setup(@Body() body: any, @Headers('x-ucli-setup-secret') secret?: string) { return this.auth.setup(body, secret) }
  @Post('login') login(@Body() body: any) { return this.auth.login(body) }
  @ApiBearerAuth() @UseGuards(AuthGuard) @Header('Cache-Control', 'no-store') @Get('me')
  me(@Req() request: any) { return this.auth.me(request.principal) }
  @ApiBearerAuth() @UseGuards(AuthGuard) @Header('Cache-Control', 'no-store') @Patch('me')
  updateProfile(@Req() request: any, @Body() body: UpdateProfileDto) { return this.auth.updateProfile(request.principal, body) }
  @Header('Cache-Control', 'no-store') @Post('device-grants/preview')
  preview(@Body() body: PreviewDeviceGrantDto) { return this.grants.preview(body.link) }
  @Header('Cache-Control', 'no-store') @Post('device-grants/redeem')
  redeem(@Body() body: RedeemDeviceGrantDto) { return this.grants.redeem(body) }
  @Header('Cache-Control', 'no-store') @Post('token/refresh')
  refresh(@Body() body: any) { return this.auth.refresh(String(body.refreshToken || '')) }
  @ApiBearerAuth() @UseGuards(AuthGuard) @Post('password')
  changePassword(@Body() body: any, @Req() request: any) {
    return this.auth.changePassword(request.principal.sub, {
      currentPassword: String(body.currentPassword || ''), newPassword: String(body.newPassword || '')
    })
  }
  @ApiBearerAuth() @UseGuards(AuthGuard) @Post('initial-credentials') @Header('Cache-Control', 'no-store')
  initialCredentials(@Body() body: InitialCredentialsDto, @Req() request: any) {
    return this.auth.updateInitialCredentials(request.principal, {
      currentPassword: body.currentPassword, newPassword: body.newPassword, newEmail: body.newEmail
    })
  }
}
