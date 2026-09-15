import { Type } from 'class-transformer'
import { IsISO8601, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator'

export class AnalyticsQueryDto {
  @IsOptional() @IsISO8601({ strict: true }) start?: string
  @IsOptional() @IsISO8601({ strict: true }) end?: string
  @IsOptional() @IsUUID() organizationId?: string
  @IsOptional() @IsUUID() accountId?: string
  @IsOptional() @IsUUID() groupId?: string
  @IsOptional() @IsUUID() apiKeyId?: string
  @IsOptional() @IsIn(['DEVICE', 'API_KEY']) credentialType?: 'DEVICE' | 'API_KEY'
  @IsOptional() @IsUUID() channelId?: string
  @IsOptional() @IsString() @Length(1, 200) publicModelId?: string
  @IsOptional() @IsString() @Length(1, 200) model?: string
  @IsOptional() @IsUUID() channelModelId?: string
  @IsOptional() @IsIn(['hour', 'day']) interval?: 'hour' | 'day'
  @IsOptional() @IsIn(['organization', 'channel', 'model', 'channelModel', 'account', 'costRule', 'group', 'apiKey'])
  dimension?: 'organization' | 'channel' | 'model' | 'channelModel' | 'account' | 'costRule' | 'group' | 'apiKey'
  @IsOptional() @IsIn(['requests', 'costCny', 'costUsd', 'tokens', 'successRate', 'p95LatencyMs'])
  sort?: 'requests' | 'costCny' | 'costUsd' | 'tokens' | 'successRate' | 'p95LatencyMs'
  @IsOptional() @IsIn(['asc', 'desc']) order?: 'asc' | 'desc'
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number
}

export class UsageQueryDto extends AnalyticsQueryDto {
  @IsOptional() @IsIn(['UTC', 'Asia/Shanghai']) timezone?: 'UTC' | 'Asia/Shanghai'
  @IsOptional() @IsIn(['SUCCESS', 'FAILED', 'CANCELLED', 'INTERRUPTED']) requestState?: 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'
  @IsOptional() @IsIn(['CONFIRMED', 'ESTIMATED', 'UNKNOWN', 'NO_CHARGE']) billingState?: 'CONFIRMED' | 'ESTIMATED' | 'UNKNOWN' | 'NO_CHARGE'
  @IsOptional() @IsIn(['UNGROUPED']) groupScope?: 'UNGROUPED'
  @IsOptional() @IsIn(['NO_KEY']) keyScope?: 'NO_KEY'
  @IsOptional() @IsUUID() costRuleId?: string
  @IsOptional() @Matches(/^[0-9a-f]{32}$/) priceKey?: string
  @IsOptional() @IsIn(['UNALLOCATED']) allocation?: 'UNALLOCATED'
  @IsOptional() @IsUUID() sessionId?: string
  @IsOptional() @IsUUID() projectId?: string
  @IsOptional() @IsString() @Length(1, 200) requestId?: string
}
