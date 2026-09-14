import { Transform } from 'class-transformer'
import { IsDateString, IsString, IsUUID, Length, ValidateIf } from 'class-validator'

export class CreateEmployeeKeyDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name!: string
  @IsUUID() groupId!: string
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
