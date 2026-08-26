import { Transform } from 'class-transformer'
import { IsEmail, IsOptional, IsString, Length } from 'class-validator'
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
