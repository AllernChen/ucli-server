import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard } from '../../../packages/security/src/auth.js'
import { AnalyticsService } from './analytics.service.js'
import { AnalyticsQueryDto } from './analytics.dto.js'
import { csvDocument } from '../../../packages/usage/src/csv.js'

@ApiTags('analytics') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('api/v1/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}
  @Get('overview') overview(@Req() request: any, @Query() query: AnalyticsQueryDto) { return this.analytics.overview(request.principal, query) }
  @Get('timeseries') timeseries(@Req() request: any, @Query() query: AnalyticsQueryDto) { return this.analytics.timeseries(request.principal, query) }
  @Get('breakdown') breakdown(@Req() request: any, @Query() query: AnalyticsQueryDto) { return this.analytics.breakdown(request.principal, query) }
  @Get('filter-options') options(@Req() request: any, @Query() query: AnalyticsQueryDto) { return this.analytics.filterOptions(request.principal, query) }
  @Get('export') @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="usage-analytics.csv"') @Header('Cache-Control', 'no-store')
  async exportCsv(@Req() request: any, @Query() query: AnalyticsQueryDto) {
    const rows = await this.analytics.exportRows(request.principal, query)
    const columns = ['id', 'name', 'requests', 'inputTokens', 'cachedTokens', 'uncachedInputTokens', 'outputTokens', 'reasoningTokens',
      'matchedCostCny', 'requestCostCny', 'estimatedCostCny', 'unallocatedCostCny', 'requestSuccessRate', 'successRate',
      'requestStates', 'unsettledRequests', 'allocationKind', 'priceKey', 'price'] as const
    return csvDocument([columns, ...rows.map(row => columns.map(key => typeof row[key] === 'object' && row[key] !== null ? JSON.stringify(row[key]) : String(row[key] ?? '')))])
  }
}
