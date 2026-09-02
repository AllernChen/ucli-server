import { Transform, Type } from 'class-transformer'
import { Allow, IsDateString, IsEmail, IsEnum, IsOptional, IsString, Length, ValidateIf } from 'class-validator'
import { Role } from '@prisma/client'
import { PageQueryDto } from './catalog.dto.js'

export class CreateManagedUserDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail() @Length(3, 320) email!: string

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) displayName!: string
}

export class ManagedUserPageQueryDto extends PageQueryDto {
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @Length(1, 200) q?: string
}

export class UpdateManagedUserRoleDto {
  @IsEnum(Role) role!: Role
}

export class CreateDeviceGrantDto {
  @IsOptional() @ValidateIf((_, value) => value !== null)
  @IsDateString({ strict: true }) expiresAt?: string | null

  @IsOptional() @ValidateIf((_, value) => value !== null)
  @IsDateString({ strict: true }) linkExpiresAt?: string | null
}

export class CreateDeviceGrantLinkDto {
  @IsOptional() @ValidateIf((_, value) => value !== null)
  @IsDateString({ strict: true }) expiresAt?: string | null
}

export class UpdateDeviceGrantDto {
  @ValidateIf((_, value) => value !== null)
  @IsDateString({ strict: true }) expiresAt!: string | null
}

export class DeviceRegistrationDto {
  // Public endpoints deliberately defer malformed input to stable domain codes.
  @Allow() installationId!: unknown
  @Allow() name!: unknown
  @Allow() platform!: unknown
  @Allow() clientVersion!: unknown
}

export class PreviewDeviceGrantDto {
  @Allow() link!: unknown
}

export class RedeemDeviceGrantDto extends PreviewDeviceGrantDto {
  @Allow() device!: unknown
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
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @Length(1, 200) q?: string
}
