-- CreateEnum
BEGIN;

-- CreateEnum
CREATE TYPE "UsageGroupType" AS ENUM ('DEPARTMENT', 'PROJECT');

-- CreateEnum
CREATE TYPE "GroupBudgetMode" AS ENUM ('TOTAL', 'MONTHLY');

-- CreateEnum
CREATE TYPE "CredentialType" AS ENUM ('DEVICE', 'API_KEY');

-- CreateEnum
CREATE TYPE "BudgetEntryKind" AS ENUM ('REQUEST', 'LIMIT_ADJUSTMENT', 'COST_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "BudgetEntryStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "BillingState" AS ENUM ('CONFIRMED', 'ESTIMATED', 'UNKNOWN', 'NO_CHARGE');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "require_device_group" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "device_grants" ADD COLUMN     "group_id" UUID;

-- AlterTable
ALTER TABLE "usage_logs" ADD COLUMN     "actor_snapshot" JSONB,
ADD COLUMN     "api_key_id" UUID,
ADD COLUMN     "credential_type" "CredentialType" NOT NULL DEFAULT 'DEVICE',
ADD COLUMN     "group_id" UUID,
ALTER COLUMN "device_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "route_attempts" ADD COLUMN     "billing_state" "BillingState",
ADD COLUMN     "cost_cny" DECIMAL(20,8),
ADD COLUMN     "usage_snapshot" JSONB;

-- CreateTable
CREATE TABLE "usage_groups" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "UsageGroupType" NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMP(3),
    "budget_mode" "GroupBudgetMode" NOT NULL DEFAULT 'TOTAL',
    "budget_timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "default_limit_cny" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "organization_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id","account_id")
);

-- CreateTable
CREATE TABLE "group_model_access" (
    "organization_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "public_model_id" TEXT NOT NULL,

    CONSTRAINT "group_model_access_pkey" PRIMARY KEY ("group_id","public_model_id")
);

-- CreateTable
CREATE TABLE "employee_api_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "secret_hint" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "employee_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_budget_periods" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "period_key" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "limit_cny" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "spent_cny" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "reserved_cny" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "alerted_threshold" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "group_budget_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_budget_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
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

    CONSTRAINT "group_budget_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_groups_organization_id_archived_at_enabled_idx" ON "usage_groups"("organization_id", "archived_at", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "usage_groups_id_organization_id_key" ON "usage_groups"("id", "organization_id");

-- CreateIndex
CREATE INDEX "group_members_organization_id_account_id_removed_at_idx" ON "group_members"("organization_id", "account_id", "removed_at");

-- CreateIndex
CREATE UNIQUE INDEX "employee_api_keys_secret_hash_key" ON "employee_api_keys"("secret_hash");

-- CreateIndex
CREATE INDEX "employee_api_keys_organization_id_group_id_account_id_idx" ON "employee_api_keys"("organization_id", "group_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_api_keys_id_organization_id_account_id_group_id_key" ON "employee_api_keys"("id", "organization_id", "account_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_budget_periods_group_id_period_key_key" ON "group_budget_periods"("group_id", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "group_budget_periods_id_organization_id_group_id_key" ON "group_budget_periods"("id", "organization_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_budget_entries_operation_id_key" ON "group_budget_entries"("operation_id");

-- CreateIndex
CREATE INDEX "group_budget_entries_status_lease_until_idx" ON "group_budget_entries"("status", "lease_until");

-- CreateIndex
CREATE INDEX "group_budget_entries_organization_id_group_id_started_at_idx" ON "group_budget_entries"("organization_id", "group_id", "started_at");

-- CreateIndex
CREATE INDEX "usage_logs_organization_id_group_id_started_at_idx" ON "usage_logs"("organization_id", "group_id", "started_at");

-- CreateIndex
CREATE INDEX "usage_logs_api_key_id_started_at_idx" ON "usage_logs"("api_key_id", "started_at");

-- AddForeignKey
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_group_id_organization_id_fkey" FOREIGN KEY ("group_id", "organization_id") REFERENCES "usage_groups"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_group_id_organization_id_fkey" FOREIGN KEY ("group_id", "organization_id") REFERENCES "usage_groups"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_api_key_id_organization_id_account_id_group_id_fkey" FOREIGN KEY ("api_key_id", "organization_id", "account_id", "group_id") REFERENCES "employee_api_keys"("id", "organization_id", "account_id", "group_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_groups" ADD CONSTRAINT "usage_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_organization_id_fkey" FOREIGN KEY ("group_id", "organization_id") REFERENCES "usage_groups"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "memberships"("organization_id", "account_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "group_model_access" ADD CONSTRAINT "group_model_access_group_id_organization_id_fkey" FOREIGN KEY ("group_id", "organization_id") REFERENCES "usage_groups"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "group_model_access" ADD CONSTRAINT "group_model_access_public_model_id_fkey" FOREIGN KEY ("public_model_id") REFERENCES "public_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_api_keys" ADD CONSTRAINT "employee_api_keys_group_id_organization_id_fkey" FOREIGN KEY ("group_id", "organization_id") REFERENCES "usage_groups"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_api_keys" ADD CONSTRAINT "employee_api_keys_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "memberships"("organization_id", "account_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_api_keys" ADD CONSTRAINT "employee_api_keys_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_budget_periods" ADD CONSTRAINT "group_budget_periods_group_id_organization_id_fkey" FOREIGN KEY ("group_id", "organization_id") REFERENCES "usage_groups"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "group_budget_entries" ADD CONSTRAINT "group_budget_entries_period_id_organization_id_group_id_fkey" FOREIGN KEY ("period_id", "organization_id", "group_id") REFERENCES "group_budget_periods"("id", "organization_id", "group_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "group_budget_entries" ADD CONSTRAINT "group_budget_entries_organization_id_account_id_fkey" FOREIGN KEY ("organization_id", "account_id") REFERENCES "memberships"("organization_id", "account_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "group_budget_entries" ADD CONSTRAINT "group_budget_entries_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_credential_shape" CHECK (
  ("credential_type" = 'DEVICE' AND "device_id" IS NOT NULL AND "api_key_id" IS NULL)
  OR ("credential_type" = 'API_KEY' AND "device_id" IS NULL AND "api_key_id" IS NOT NULL AND "group_id" IS NOT NULL)
);
ALTER TABLE "usage_groups" ADD CONSTRAINT "group_nonnegative_limit" CHECK ("default_limit_cny" >= 0 AND "default_limit_cny" != 'NaN'::numeric);
ALTER TABLE "group_budget_periods" ADD CONSTRAINT "group_budget_nonnegative" CHECK (
  "limit_cny" >= 0 AND "spent_cny" >= 0 AND "reserved_cny" >= 0
  AND "limit_cny" != 'NaN'::numeric AND "spent_cny" != 'NaN'::numeric AND "reserved_cny" != 'NaN'::numeric
);
ALTER TABLE "group_budget_entries" ADD CONSTRAINT "group_entry_shape" CHECK (
  "reserved_cny" >= 0 AND "settled_cny" >= 0 AND "reserved_cny" != 'NaN'::numeric AND "settled_cny" != 'NaN'::numeric AND (
    ("kind" = 'REQUEST' AND "request_id" IS NOT NULL AND "account_id" IS NOT NULL AND "credential_type" IS NOT NULL AND "credential_id" IS NOT NULL)
    OR ("kind" != 'REQUEST' AND "request_id" IS NULL AND "reason" IS NOT NULL AND length(trim("reason")) > 0 AND "actor_account_id" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "group_budget_request_once" ON "group_budget_entries" ("request_id") WHERE "kind" = 'REQUEST';

CREATE FUNCTION prevent_employee_key_reassignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.organization_id, NEW.account_id, NEW.group_id) IS DISTINCT FROM (OLD.organization_id, OLD.account_id, OLD.group_id) THEN
    RAISE EXCEPTION 'Employee API key ownership is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER employee_key_ownership_immutable BEFORE UPDATE ON "employee_api_keys"
FOR EACH ROW EXECUTE FUNCTION prevent_employee_key_reassignment();

COMMIT;
