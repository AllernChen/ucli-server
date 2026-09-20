import { Transform } from 'class-transformer'
import { ArrayMaxSize, ArrayUnique, IsArray, IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator'
import { OrgUnitType } from '@prisma/client'
import { PageQueryDto } from './catalog.dto.js'

export class OrgUnitPageQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(OrgUnitType) kind?: OrgUnitType
  @IsIn(['active', 'disabled', 'archived', 'all']) status: 'active' | 'disabled' | 'archived' | 'all' = 'active'
  @IsOptional() @IsString() @Length(1, 200) q?: string
}

export class CreateOrgUnitDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name!: string
  @IsIn(['EXECUTIVE', 'FUNCTIONAL', 'REGION']) kind!: Exclude<OrgUnitType, 'LEGACY_PROJECT'>
  @ValidateIf((_, value) => value !== undefined) @IsString() @Length(0, 2000) description?: string
}

export class UpdateOrgUnitDto {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name?: string
  @ValidateIf((_, value) => value !== undefined) @IsString() @Length(0, 2000) description?: string
}

export class AddOrgUnitMemberDto {
  @IsUUID() accountId!: string
}

export class ReplaceOrgUnitModelsDto {
  @IsArray() @ArrayUnique() @ArrayMaxSize(1000)
  @IsString({ each: true }) @Length(1, 200, { each: true }) publicModelIds!: string[]
}
