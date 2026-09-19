import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, type AuthPrincipal } from '../../../packages/security/src/auth.js'
import { MeProjectsService } from './me-projects.service.js'

type AuthRequest = { principal: AuthPrincipal }

@ApiTags('me/projects') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/me/projects')
export class MeProjectsController {
  constructor(private readonly projects: MeProjectsService) {}

  @Get() @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthRequest, @Query('regionId') regionId?: string) {
    return this.projects.list(req.principal, regionId || undefined)
  }
}
