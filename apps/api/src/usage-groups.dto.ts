import { Transform } from 'class-transformer'
import { ArrayMaxSize, ArrayUnique, IsArray, IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator'
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

export class ReplaceGroupModelsDto {
  @IsArray() @ArrayUnique() @ArrayMaxSize(1000)
  @IsString({ each: true }) @Length(1, 200, { each: true }) publicModelIds!: string[]
}
