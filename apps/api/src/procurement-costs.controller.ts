import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { UuidPipe } from '../../../packages/http/src/uuid.pipe.js'
import { CostEvaluationDto, ProcurementCostQueryDto } from './catalog.dto.js'
import { ProcurementCostsService } from './procurement-costs.service.js'

@ApiTags('admin/procurement-costs') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/admin')
export class ProcurementCostsController {
  constructor(private readonly procurementCosts: ProcurementCostsService) {}

  @Get('procurement-costs')
  list(@Query() query: ProcurementCostQueryDto) {
    return this.procurementCosts.list(query)
  }

  @Post('channel-models/:id/cost-evaluation')
  evaluate(@Param('id', UuidPipe) id: string, @Body() body: CostEvaluationDto) {
    return this.procurementCosts.evaluate(id, body)
  }
}
