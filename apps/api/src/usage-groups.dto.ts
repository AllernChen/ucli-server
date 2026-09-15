import { Transform, Type } from 'class-transformer'
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateIf, ValidateNested } from 'class-validator'
import { UsageGroupType } from '@prisma/client'
import { PageQueryDto } from './catalog.dto.js'

export class CreateUsageGroupDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name!: string
  @IsEnum(UsageGroupType) type!: UsageGroupType
  @ValidateIf((_, value) => value !== undefined) @IsString() @Length(0, 2000) description?: string
}

export class UpdateUsageGroupDto {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name?: string
  @ValidateIf((_, value) => value !== undefined) @IsString() @Length(0, 2000) description?: string
}

export class UsageGroupPageQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(UsageGroupType) type?: UsageGroupType
  @IsIn(['active', 'disabled', 'archived', 'all']) status: 'active' | 'disabled' | 'archived' | 'all' = 'active'
  @IsOptional() @IsString() @Length(1, 200) q?: string
}

export class AddGroupMemberDto {
  @IsUUID() accountId!: string
}

export class GroupModelOptionsDto {
  @IsOptional() @IsUUID() accountId?: string
}

export class ReplaceGroupModelsDto {
  @IsArray() @ArrayUnique() @ArrayMaxSize(1000)
  @IsString({ each: true }) @Length(1, 200, { each: true }) publicModelIds!: string[]
}

class BudgetOperationDto {
  @IsUUID() operationId!: string
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 2000) reason!: string
}

export class BudgetConfigDto extends BudgetOperationDto {
  @IsIn(['TOTAL', 'MONTHLY']) budgetMode!: 'TOTAL' | 'MONTHLY'
  @IsString() @Length(1, 100) budgetTimezone!: string
}

export class BudgetAdjustmentDto extends BudgetOperationDto {
  @IsIn(['CURRENT', 'DEFAULT']) scope!: 'CURRENT' | 'DEFAULT'
  @ValidateIf((_, value) => value !== undefined) @IsUUID() periodId?: string
  @IsString() @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/) limitCny!: string
  @IsBoolean() unlimited!: boolean
}

class RouteCostDto {
  @IsUUID() id!: string
  @IsString() @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/) costCny!: string
}

export class BudgetReconcileDto extends BudgetOperationDto {
  @IsIn(['SETTLE', 'RELEASE']) action!: 'SETTLE' | 'RELEASE'
  @IsString() @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/) actualCny!: string
  @ValidateIf((_, value) => value !== undefined) @IsArray() @ArrayMaxSize(1000)
  @ValidateNested({ each: true }) @Type(() => RouteCostDto) routes?: RouteCostDto[]
}
