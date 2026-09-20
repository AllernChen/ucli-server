import { Transform } from 'class-transformer'
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator'
import { PageQueryDto } from './catalog.dto.js'

export class ProjectOptionQueryDto {
  @IsUUID() regionId!: string
}

export class EmployeeKeyQueryDto extends PageQueryDto {
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) q?: string
  @IsOptional() @IsUUID() accountId?: string
  @IsOptional() @IsUUID() groupId?: string
  @IsOptional() @IsUUID() projectId?: string
  @IsOptional() @IsIn(['active', 'disabled', 'expired', 'revoked']) status?: 'active' | 'disabled' | 'expired' | 'revoked'
}

export class CreateEmployeeKeyDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name!: string
  @IsUUID() projectId!: string
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString({ strict: true }) expiresAt?: string | null
}

export class UpdateEmployeeKeyDto {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name?: string
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDateString({ strict: true }) expiresAt?: string | null
}

export class RevealEmployeeKeyDto {
  @IsString()
  @Length(1, 200)
  password!: string
}
