-- Extend usage groups with the region boundary and add project budget ownership.
BEGIN;

-- AlterEnum
ALTER TYPE "UsageGroupType" ADD VALUE 'REGION';

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProjectMemberRole" AS ENUM ('OWNER', 'CONTRIBUTOR', 'VIEWER');

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "region_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "source_group_id" UUID,
    "budget_mode" "GroupBudgetMode" NOT NULL DEFAULT 'TOTAL',
    "budget_timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "role" "ProjectMemberRole" NOT NULL DEFAULT 'CONTRIBUTOR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id","account_id")
);

-- CreateTable
CREATE TABLE "project_budget_periods" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "period_key" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "limit_cny" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "spent_cny" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "reserved_cny" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "alerted_threshold" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "project_budget_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_budget_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "request_id" TEXT,
    "operation_id" TEXT NOT NULL,
    "kind" "BudgetEntryKind" NOT NULL,
    "status" "BudgetEntryStatus" NOT NULL,
    "account_id" UUID,
    "credential_type" "CredentialType",
    "credential_id" UUID,
    "reserved_cny" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "settled_cny" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "dispatched_at" TIMESTAMP(3),
    "lease_until" TIMESTAMP(3),
    "snapshot" JSONB NOT NULL,
    "reason" TEXT,
    "actor_account_id" UUID,

    CONSTRAINT "project_budget_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_budget_applications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "applicant_account_id" UUID NOT NULL,
    "requested_cny" DECIMAL(20,8) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "BudgetApplicationStatus" NOT NULL DEFAULT 'REGISTERED',
    "approved_cny" DECIMAL(20,8),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "linked_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_budget_applications_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "employee_api_keys" ADD COLUMN     "project_id" UUID;

-- AlterTable
ALTER TABLE "device_grants" ADD COLUMN     "project_id" UUID;

-- AlterTable
ALTER TABLE "usage_logs" ADD COLUMN     "budget_project_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "projects_id_organization_id_key" ON "projects"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_organization_id_code_key" ON "projects"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "projects_organization_id_region_id_name_key" ON "projects"("organization_id", "region_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "projects_source_group_id_key" ON "projects"("source_group_id");

-- CreateIndex
CREATE INDEX "projects_org_region_status_idx" ON "projects"("organization_id", "region_id", "status");

-- CreateIndex
CREATE INDEX "project_members_organization_id_account_id_idx" ON "project_members"("organization_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_budget_periods_project_id_period_key_key" ON "project_budget_periods"("project_id", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "project_budget_periods_id_organization_id_project_id_key" ON "project_budget_periods"("id", "organization_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_budget_entries_operation_id_key" ON "project_budget_entries"("operation_id");

-- CreateIndex
CREATE INDEX "project_budget_entries_state_idx" ON "project_budget_entries"("status", "lease_until");

-- CreateIndex
CREATE INDEX "project_budget_entries_project_time_idx" ON "project_budget_entries"("organization_id", "project_id", "started_at");

-- CreateIndex
CREATE INDEX "project_budget_applications_organization_id_project_id_created_at_idx" ON "project_budget_applications"("organization_id", "project_id", "created_at");

-- CreateIndex
CREATE INDEX "project_budget_applications_organization_id_project_id_status_idx" ON "project_budget_applications"("organization_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "employee_api_keys_organization_id_project_id_account_id_idx" ON "employee_api_keys"("organization_id", "project_id", "account_id");

-- CreateIndex
CREATE INDEX "device_grants_organization_id_project_id_idx" ON "device_grants"("organization_id", "project_id");

-- CreateIndex
CREATE INDEX "usage_logs_budget_project_time_idx" ON "usage_logs"("organization_id", "budget_project_id", "started_at");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_region_id_organization_id_fkey" FOREIGN KEY ("region_id", "organization_id") REFERENCES "usage_groups"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_organization_id_fkey" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "memberships"("organization_id", "account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_budget_periods" ADD CONSTRAINT "project_budget_periods_project_id_organization_id_fkey" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_budget_entries" ADD CONSTRAINT "project_budget_entries_period_id_organization_id_project_id_fkey" FOREIGN KEY ("period_id", "organization_id", "project_id") REFERENCES "project_budget_periods"("id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_budget_entries" ADD CONSTRAINT "project_budget_entries_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "memberships"("organization_id", "account_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_budget_entries" ADD CONSTRAINT "project_budget_entries_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_budget_applications" ADD CONSTRAINT "project_budget_applications_project_id_organization_id_fkey" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_budget_applications" ADD CONSTRAINT "project_budget_applications_organization_id_applicant_account_id_fkey" FOREIGN KEY ("organization_id", "applicant_account_id") REFERENCES "memberships"("organization_id", "account_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_budget_applications" ADD CONSTRAINT "project_budget_applications_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_api_keys" ADD CONSTRAINT "employee_api_keys_project_id_organization_id_fkey" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_project_id_organization_id_fkey" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_budget_project_id_organization_id_fkey" FOREIGN KEY ("budget_project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "project_budget_periods" ADD CONSTRAINT "project_budget_nonnegative" CHECK (
  "limit_cny" >= 0 AND "spent_cny" >= 0 AND "reserved_cny" >= 0
  AND "limit_cny" != 'NaN'::numeric AND "spent_cny" != 'NaN'::numeric AND "reserved_cny" != 'NaN'::numeric
);
ALTER TABLE "project_budget_entries" ADD CONSTRAINT "project_entry_shape" CHECK (
  "reserved_cny" >= 0 AND "settled_cny" >= 0 AND "reserved_cny" != 'NaN'::numeric AND "settled_cny" != 'NaN'::numeric AND (
    ("kind" = 'REQUEST' AND "request_id" IS NOT NULL AND "account_id" IS NOT NULL AND "credential_type" IS NOT NULL AND "credential_id" IS NOT NULL)
    OR ("kind" != 'REQUEST' AND "request_id" IS NULL AND "reason" IS NOT NULL AND length(trim("reason")) > 0 AND "actor_account_id" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "project_budget_request_once" ON "project_budget_entries" ("request_id") WHERE "kind" = 'REQUEST';

COMMIT;
