import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator'
import type { Response } from 'express'
import { AuthGuard, Roles } from '../../../packages/security/src/auth.js'
import { ModelTestingService } from './model-testing.service.js'

class ModelTestMessageDto {
  @IsIn(['system', 'user', 'assistant']) role!: 'system' | 'user' | 'assistant'
  @IsString() @Length(1, 20_000) content!: string
}

export class AdminModelTestDto {
  @IsUUID('4') channelModelId!: string
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ModelTestMessageDto)
  messages!: ModelTestMessageDto[]
  @IsNumber() @Min(0) @Max(2) temperature!: number
  @IsNumber() @Min(1) @Max(8192) maxTokens!: number
  @IsOptional() @IsUUID('4') keyId?: string
}

@ApiTags('admin/model-tests') @ApiBearerAuth() @UseGuards(AuthGuard) @Roles('PLATFORM_ADMIN')
@Controller('api/v1/admin/model-tests')
export class ModelTestingController {
  constructor(private readonly modelTesting: ModelTestingService) {}

  @Post()
  test(@Body() body: AdminModelTestDto, @Req() request: any) {
    return this.modelTesting.runConversation(body, request.principal.sub)
  }

  @Post('stream')
  async stream(@Body() body: AdminModelTestDto, @Req() request: any, @Res() response: Response) {
    response.status(200)
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-cache, no-transform')
    response.setHeader('connection', 'keep-alive')
    response.flushHeaders()
    const abort = new AbortController()
    const cancel = () => abort.abort()
    request.once('close', cancel)
    const send = (event: 'delta' | 'metrics' | 'done' | 'error', data: unknown) => {
      if (!response.writableEnded && !abort.signal.aborted) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    try {
      const result = await this.modelTesting.runConversation(body, request.principal.sub, abort.signal)
      if (result.assistantMessage) send('delta', { content: result.assistantMessage })
      const { assistantMessage: _assistant, rawResponse, ...metrics } = result
      send('metrics', metrics)
      send('done', { rawResponse })
    } catch (error: any) {
      if (!abort.signal.aborted) send('error', { message: error?.message || 'Model test failed' })
    } finally {
      request.off('close', cancel)
      if (!response.writableEnded) response.end()
    }
  }
}
