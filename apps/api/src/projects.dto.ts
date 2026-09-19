import { Transform } from 'class-transformer'
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateIf } from 'class-validator'
import { PageQueryDto } from './catalog.dto.js'

export type ProjectStatusFilter = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'
export type ProjectMemberRole = 'OWNER' | 'CONTRIBUTOR' | 'VIEWER'

export class ProjectPageQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID() regionId?: string
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED', 'ARCHIVED']) status?: ProjectStatusFilter
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 200) q?: string
}

export class CreateProjectDto {
  @IsUUID() regionId!: string
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString() @Matches(/^[A-Z0-9][A-Z0-9_-]{1,59}$/) code!: string
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name!: string
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(0, 2000) description?: string
}

export class UpdateProjectDto {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name?: string
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(0, 2000) description?: string
}

export class AddProjectMemberDto {
  @IsUUID() accountId!: string
  @IsIn(['OWNER', 'CONTRIBUTOR', 'VIEWER']) role!: ProjectMemberRole
}

export class SetProjectMemberRoleDto {
  @IsIn(['OWNER', 'CONTRIBUTOR', 'VIEWER']) role!: ProjectMemberRole
}
