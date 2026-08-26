import { Transform } from 'class-transformer'
import { IsDateString, IsEmail, IsEnum, IsOptional, IsString, Length, ValidateIf } from 'class-validator'
import { PageQueryDto } from './catalog.dto.js'

export class CreateManagedUserDto {
  @Transform(({ value }) => String(value).trim().toLowerCase())
  @IsEmail() @Length(3, 320) email!: string

  @Transform(({ value }) => String(value).trim())
  @IsString() @Length(1, 120) displayName!: string
}

export class ManagedUserPageQueryDto extends PageQueryDto {
  @IsOptional() @Transform(({ value }) => String(value).trim()) @IsString() @Length(1, 200) q?: string
}

export class CreateDeviceGrantDto {
  @IsOptional() @ValidateIf((_, value) => value !== null)
  @IsDateString({ strict: true }) expiresAt?: string | null
}

export class UpdateDeviceGrantDto {
  @ValidateIf((_, value) => value !== null)
  @IsDateString({ strict: true }) expiresAt!: string | null
}

export enum DeviceGrantFilter {
  ALL = 'ALL',
  AVAILABLE = 'AVAILABLE',
  BOUND = 'BOUND',
  DISABLED = 'DISABLED',
  EXPIRED = 'EXPIRED',
  DELETED = 'DELETED'
}

export class DeviceGrantPageQueryDto extends PageQueryDto {
  @IsOptional() @IsEnum(DeviceGrantFilter) status: DeviceGrantFilter = DeviceGrantFilter.ALL
  @IsOptional() @Transform(({ value }) => String(value).trim()) @IsString() @Length(1, 200) q?: string
}
