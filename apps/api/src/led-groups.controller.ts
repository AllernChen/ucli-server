import { Controller, Get, Header, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, type AuthPrincipal } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { LedGroupsService } from './led-groups.service.js'

type AuthRequest = { principal: AuthPrincipal }

@ApiTags('profile/led-groups') @ApiBearerAuth() @UseGuards(AuthGuard)
@Controller('api/v1/me/led-groups')
export class LedGroupsController {
  constructor(private readonly ledGroups: LedGroupsService) {}

  @Get() @Header('Cache-Control', 'no-store')
  list(@Req() request: AuthRequest) { return this.ledGroups.list(request.principal) }

  @Get(':id/budget') @Header('Cache-Control', 'no-store')
  budget(@Req() request: AuthRequest, @Param('id', UuidPipe) id: string) { return this.ledGroups.budget(request.principal, id) }

  @Get(':id/usage') @Header('Cache-Control', 'no-store')
  usage(@Req() request: AuthRequest, @Param('id', UuidPipe) id: string,
    @Query('start') start?: string, @Query('end') end?: string,
    @Query('limit') limit?: number, @Query('offset') offset?: number) {
    return this.ledGroups.usage(request.principal, id, { start, end, limit, offset })
  }
}
