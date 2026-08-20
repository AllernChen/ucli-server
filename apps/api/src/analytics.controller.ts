import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { AnalyticsService } from './analytics.service.js'

@ApiTags('analytics') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}
  @Get('overview') overview(@Req() request: any, @Query() query: any) { return this.analytics.overview(request.principal, query) }
  @Get('timeseries') timeseries(@Req() request: any, @Query() query: any) { return this.analytics.timeseries(request.principal, query) }
  @Get('breakdown') breakdown(@Req() request: any, @Query() query: any) { return this.analytics.breakdown(request.principal, query) }
  @Get('filter-options') options(@Req() request: any, @Query() query: any) { return this.analytics.filterOptions(request.principal, query) }
}
