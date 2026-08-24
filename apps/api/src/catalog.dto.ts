import { Transform, Type } from 'class-transformer'
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional,
  IsDateString, IsString, IsTimeZone, IsUrl, IsUUID, Length, Matches, Max, Min,
  Validate, ValidateIf, ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface
} from 'class-validator'
import { ChannelProtocol, GatewayProtocol, HealthStatus, KeySelection, ModelHealthStatus } from '@prisma/client'

export enum CatalogLifecycle {
  ACTIVE = 'ACTIVE',
  ARCHIVED = 'ARCHIVED',
  ALL = 'ALL'
}

export enum ProcurementCostStatus {
  CHANNEL_RULE_ACTIVE = 'CHANNEL_RULE_ACTIVE',
  PARTIAL_FALLBACK = 'PARTIAL_FALLBACK',
  FALLBACK_ONLY = 'FALLBACK_ONLY',
  NO_COST = 'NO_COST',
  UPCOMING = 'UPCOMING',
  DISABLED = 'DISABLED'
}

const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/

@ValidatorConstraint({ name: 'isAfterValidFrom', async: false })
class IsAfterValidFromConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    if (value === undefined || value === null) return true
    if (typeof value !== 'string') return false
    const validFrom = (args.object as { validFrom?: unknown }).validFrom
    if (typeof validFrom !== 'string') return true
    const from = new Date(validFrom)
    const until = new Date(value)
    return Number.isFinite(from.getTime()) && Number.isFinite(until.getTime()) && until > from
  }

  defaultMessage() { return 'validUntil must be later than validFrom' }
}

export class PageQueryDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 50
  @Type(() => Number) @IsInt() @Min(0) offset = 0
}

export class LifecyclePageQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(CatalogLifecycle) lifecycle: CatalogLifecycle = CatalogLifecycle.ACTIVE
}

export class ProcurementCostQueryDto extends PageQueryDto {
  @IsOptional() @IsString() @Length(1, 100) manufacturer?: string
  @IsOptional() @IsString() @Length(1, 200) publicModelId?: string
  @IsOptional() @IsUUID('4') channelId?: string
  @IsOptional() @IsEnum(ProcurementCostStatus) status?: ProcurementCostStatus
  @IsOptional() @IsString() @Length(1, 200) search?: string
}

export class CostEvaluationDto {
  @IsDateString({ strict: true }) at!: string
  @Type(() => Number) @IsInt() @Min(0) inputTokens!: number
  @Type(() => Number) @IsInt() @Min(0) outputTokens!: number
  @Type(() => Number) @IsInt() @Min(0) cachedTokens = 0
  @Type(() => Number) @IsInt() @Min(0) reasoningTokens = 0
}

export class CreatePublicModelDto {
  @IsString() @Length(1, 200) id!: string
  @IsString() @Length(1, 200) displayName!: string
  @IsString() @Length(1, 100) manufacturer!: string
  @IsOptional() @IsInt() @Min(1) contextSize?: number | null
}

export class UpdatePublicModelDto {
  @IsOptional() @IsString() @Length(1, 200) displayName?: string
  @IsOptional() @IsString() @Length(1, 100) manufacturer?: string
  @IsOptional() @IsInt() @Min(1) contextSize?: number | null
}

export class CreatePublicModelAbilityDto {
  @IsUUID('4') channelId!: string
  @IsString() @Length(1, 300) upstreamModel!: string
  @IsEnum(GatewayProtocol) protocol!: GatewayProtocol
  @IsOptional() @IsBoolean() supportsStream = true
  @IsOptional() @IsBoolean() supportsTools = true
  @IsOptional() @IsBoolean() probeEnabled = true
  @IsOptional() @IsInt() @Min(5) @Max(1440) probeIntervalMinutes = 15
}

export class ArchivePublicModelAbilityDto {
  @IsUUID('4') channelId!: string
  @IsEnum(GatewayProtocol) protocol!: GatewayProtocol
}

export class CreateModelPriceDto {
  @Matches(NON_NEGATIVE_DECIMAL) inputPerMillion!: string
  @Matches(NON_NEGATIVE_DECIMAL) outputPerMillion!: string
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL) cachedPerMillion = '0'
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL) reasoningPerMillion = '0'
  @IsOptional() @IsIn(['CNY']) currency = 'CNY'
  @IsOptional() @IsDateString({ strict: true }) validFrom?: string
  @IsOptional() @IsDateString({ strict: true }) @Validate(IsAfterValidFromConstraint) validUntil?: string | null
}

export class UpdateModelPriceDto {
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL) inputPerMillion?: string
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL) outputPerMillion?: string
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL) cachedPerMillion?: string
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL) reasoningPerMillion?: string
  @IsOptional() @IsIn(['CNY']) currency?: string
  @IsOptional() @IsDateString({ strict: true }) validFrom?: string
  @IsOptional() @IsDateString({ strict: true }) @Validate(IsAfterValidFromConstraint) validUntil?: string | null
}

export class ChannelListQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(CatalogLifecycle) lifecycle: CatalogLifecycle = CatalogLifecycle.ACTIVE
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
  @IsOptional() @IsUrl({
    protocols: ['http', 'https'], require_protocol: true, require_valid_protocol: true, require_tld: false, disallow_auth: true
  }) modelDiscoveryUrl?: string | null
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
  @IsOptional() @IsUrl({
    protocols: ['http', 'https'], require_protocol: true, require_valid_protocol: true, require_tld: false, disallow_auth: true
  }) modelDiscoveryUrl?: string | null
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

export class BindChannelModelDto {
  @IsString() @Length(1, 200) publicModelId!: string
  @IsOptional() @IsBoolean() createPublicModel = false
  @ValidateIf(input => input.createPublicModel === true)
  @IsString() @Length(1, 200) publicModelDisplayName?: string
  @ValidateIf(input => input.createPublicModel === true)
  @IsString() @Length(1, 100) manufacturer?: string
  @IsOptional() @IsInt() @Min(1) contextSize?: number | null
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
  @IsOptional() @IsString() validUntil?: string | null
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
  @IsOptional() @IsString() validUntil?: string | null
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
