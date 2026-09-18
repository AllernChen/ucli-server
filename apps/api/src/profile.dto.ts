import { Transform } from 'class-transformer'
import { IsEmail, IsOptional, IsString, Length } from 'class-validator'

export class UpdateProfileDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) displayName!: string
}

export class InitialCredentialsDto {
  @IsString() currentPassword!: string
  @IsString() @Length(8, 128) newPassword!: string
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail() @Length(3, 320) newEmail?: string
}
