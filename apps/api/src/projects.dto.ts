import { Transform } from 'class-transformer'
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateIf } from 'class-validator'
import { PageQueryDto } from './catalog.dto.js'

export type ProjectStatusFilter = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'
export type ProjectMemberRole = 'OWNER' | 'CONTRIBUTOR' | 'VIEWER'

export class ProjectPageQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID() regionId?: string
  @IsOptional() @IsUUID() ownerOrgUnitId?: string
  @IsOptional() @IsIn(['BUSINESS', 'DEPARTMENT']) category?: 'BUSINESS' | 'DEPARTMENT'
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED', 'ARCHIVED']) status?: ProjectStatusFilter
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 200) q?: string
}

export class CreateProjectDto {
  @IsOptional() @IsUUID() regionId?: string
  @IsOptional() @IsUUID() ownerOrgUnitId?: string
  @IsOptional() @IsIn(['BUSINESS', 'DEPARTMENT']) category?: 'BUSINESS' | 'DEPARTMENT'
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString() @Matches(/^[A-Z0-9][A-Z0-9_-]{1,59}$/) code!: string
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name!: string
  @ValidateIf((_, value) => value !== undefined)
  @IsUUID() sourceGroupId?: string
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

export class ProjectBudgetAdjustmentDto {
  @IsUUID() operationId!: string
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 2000) reason!: string
  @IsString() @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/) limitCny!: string
  @IsBoolean() unlimited!: boolean
  @IsOptional() @IsUUID() applicationId?: string
}

export class CreateProjectBudgetApplicationDto {
  @IsString() @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/) requestedCny!: string
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 2000) reason!: string
  @IsOptional() @IsUUID() applicantAccountId?: string
}

export class SubmitAndApproveProjectBudgetDto {
  @IsUUID() operationId!: string
  @IsString() @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/) requestedTotalCny!: string
  @IsBoolean() unlimited!: boolean
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 2000) reason!: string
}

export class ProjectBudgetApplicationDecisionDto {
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(0, 2000) note?: string
}
