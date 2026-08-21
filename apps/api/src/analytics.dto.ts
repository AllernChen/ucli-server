import { Type } from 'class-transformer'
import { IsISO8601, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator'

export class AnalyticsQueryDto {
  @IsOptional() @IsISO8601({ strict: true }) start?: string
  @IsOptional() @IsISO8601({ strict: true }) end?: string
  @IsOptional() @IsUUID() organizationId?: string
  @IsOptional() @IsUUID() accountId?: string
  @IsOptional() @IsUUID() channelId?: string
  @IsOptional() @IsString() @Length(1, 200) publicModelId?: string
  @IsOptional() @IsString() @Length(1, 200) model?: string
  @IsOptional() @IsUUID() channelModelId?: string
  @IsOptional() @IsIn(['hour', 'day']) interval?: 'hour' | 'day'
  @IsOptional() @IsIn(['organization', 'channel', 'model', 'channelModel', 'account', 'costRule'])
  dimension?: 'organization' | 'channel' | 'model' | 'channelModel' | 'account' | 'costRule'
  @IsOptional() @IsIn(['requests', 'costUsd', 'tokens', 'successRate', 'p95LatencyMs'])
  sort?: 'requests' | 'costUsd' | 'tokens' | 'successRate' | 'p95LatencyMs'
  @IsOptional() @IsIn(['asc', 'desc']) order?: 'asc' | 'desc'
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number
}
