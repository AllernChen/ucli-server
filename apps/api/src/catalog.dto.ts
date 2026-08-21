import { Transform, Type } from 'class-transformer'
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional,
  IsString, IsTimeZone, IsUrl, IsUUID, Length, Matches, Max, Min
} from 'class-validator'
import { ChannelProtocol, GatewayProtocol, HealthStatus, KeySelection, ModelHealthStatus } from '@prisma/client'

export class PageQueryDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 50
  @Type(() => Number) @IsInt() @Min(0) offset = 0
}

export class ChannelListQueryDto extends PageQueryDto {
  @IsOptional() @IsString() q?: string
  @IsOptional() @IsString() provider?: string
  @IsOptional() @IsEnum(ChannelProtocol) protocol?: ChannelProtocol
  @IsOptional() @IsEnum(HealthStatus) health?: HealthStatus
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() enabled?: boolean
}

export class CreateChannelDto {
  @IsString() @Length(1, 100) name!: string
  @IsString() @Length(1, 100) provider!: string
  @IsEnum(ChannelProtocol) protocol!: ChannelProtocol
  @IsUrl({ require_protocol: true, require_tld: false }) baseUrl!: string
  @IsOptional() @IsInt() priority = 0
  @IsOptional() @IsInt() @Min(1) weight = 1
  @IsOptional() @IsInt() @Min(1000) @Max(600000) timeoutMs = 300000
  @IsOptional() @IsInt() @Min(0) @Max(10) maxRetries = 1
  @IsOptional() @IsEnum(KeySelection) keySelection: KeySelection = KeySelection.WEIGHTED_RANDOM
  @IsOptional() @IsTimeZone() costTimezone = 'UTC'
}

export class UpdateChannelDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string
  @IsOptional() @IsString() @Length(1, 100) provider?: string
  @IsOptional() @IsEnum(ChannelProtocol) protocol?: ChannelProtocol
  @IsOptional() @IsUrl({ require_protocol: true, require_tld: false }) baseUrl?: string
  @IsOptional() @IsInt() priority?: number
  @IsOptional() @IsInt() @Min(1) weight?: number
  @IsOptional() @IsInt() @Min(1000) @Max(600000) timeoutMs?: number
  @IsOptional() @IsInt() @Min(0) @Max(10) maxRetries?: number
  @IsOptional() @IsEnum(KeySelection) keySelection?: KeySelection
  @IsOptional() @IsBoolean() autoDisable?: boolean
  @IsOptional() @IsTimeZone() costTimezone?: string
}

export class CreateChannelModelDto {
  @IsString() @Length(1, 200) publicModelId!: string
  @IsString() @Length(1, 300) upstreamModel!: string
  @IsEnum(GatewayProtocol) protocol!: GatewayProtocol
  @IsOptional() @IsBoolean() supportsStream = true
  @IsOptional() @IsBoolean() supportsTools = true
  @IsOptional() @IsBoolean() probeEnabled = true
  @IsOptional() @IsInt() @Min(5) @Max(1440) probeIntervalMinutes = 15
}

export class UpdateChannelModelDto {
  @IsOptional() @IsString() @Length(1, 300) upstreamModel?: string
  @IsOptional() @IsBoolean() supportsStream?: boolean
  @IsOptional() @IsBoolean() supportsTools?: boolean
  @IsOptional() @IsBoolean() enabled?: boolean
  @IsOptional() @IsEnum(ModelHealthStatus) health?: ModelHealthStatus
  @IsOptional() @IsBoolean() probeEnabled?: boolean
  @IsOptional() @IsInt() @Min(5) @Max(1440) probeIntervalMinutes?: number
}

export class CreateCostRuleDto {
  @IsString() @Length(1, 80) name!: string
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true }) daysOfWeek!: number[]
  @IsInt() @Min(0) @Max(1439) startMinute!: number
  @IsInt() @Min(0) @Max(1439) endMinute!: number
  @IsOptional() @IsInt() @Min(0) @Max(1000) priority = 0
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/) inputPerMillion!: string
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/) outputPerMillion!: string
  @IsOptional() @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/) cachedPerMillion = '0'
  @IsOptional() @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/) reasoningPerMillion = '0'
  @IsString() validFrom!: string
  @IsOptional() @IsString() validUntil?: string
}

export class UpdateCostRuleDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string
  @IsOptional() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true }) daysOfWeek?: number[]
  @IsOptional() @IsInt() @Min(0) @Max(1439) startMinute?: number
  @IsOptional() @IsInt() @Min(0) @Max(1439) endMinute?: number
  @IsOptional() @IsInt() @Min(0) @Max(1000) priority?: number
  @IsOptional() @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/) inputPerMillion?: string
  @IsOptional() @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/) outputPerMillion?: string
  @IsOptional() @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/) cachedPerMillion?: string
  @IsOptional() @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/) reasoningPerMillion?: string
  @IsOptional() @IsString() validFrom?: string
  @IsOptional() @IsString() validUntil?: string
  @IsOptional() @IsBoolean() enabled?: boolean
}

export class PreviewCostRuleDto extends CreateCostRuleDto {
  @IsOptional() @IsUUID('4') id?: string
}

export class CostRulePreviewDto {
  @IsArray() @ArrayNotEmpty() rules!: CreateCostRuleDto[]
  @IsString() timezone!: string
}

export class BatchTestChannelModelsDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(20) @IsUUID('4', { each: true }) channelModelIds!: string[]
}

export class AnalyticsSortDto {
  @IsOptional() @IsIn(['asc', 'desc']) order: 'asc' | 'desc' = 'desc'
}
