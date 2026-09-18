-- CreateEnum
BEGIN;

CREATE TYPE "GroupMemberRole" AS ENUM ('LEADER', 'MEMBER');

-- CreateEnum
CREATE TYPE "BudgetApplicationStatus" AS ENUM ('REGISTERED', 'LINKED', 'REJECTED');

-- AlterTable
ALTER TABLE "group_members" ADD COLUMN     "role" "GroupMemberRole" NOT NULL DEFAULT 'MEMBER';

-- CreateTable
CREATE TABLE "group_budget_applications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
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

    CONSTRAINT "group_budget_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_budget_applications_organization_id_group_id_created__idx" ON "group_budget_applications"("organization_id", "group_id", "created_at");

-- CreateIndex
CREATE INDEX "group_budget_applications_organization_id_group_id_status_idx" ON "group_budget_applications"("organization_id", "group_id", "status");

-- RenameForeignKey
ALTER TABLE "channel_models" RENAME CONSTRAINT "channel_abilities_channel_id_fkey" TO "channel_models_channel_id_fkey";

-- RenameForeignKey
ALTER TABLE "channel_models" RENAME CONSTRAINT "channel_abilities_public_model_id_fkey" TO "channel_models_public_model_id_fkey";

-- AddForeignKey
ALTER TABLE "group_budget_applications" ADD CONSTRAINT "group_budget_applications_group_id_organization_id_fkey" FOREIGN KEY ("group_id", "organization_id") REFERENCES "usage_groups"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "group_budget_applications" ADD CONSTRAINT "group_budget_applications_organization_id_applicant_accoun_fkey" FOREIGN KEY ("organization_id", "applicant_account_id") REFERENCES "memberships"("organization_id", "account_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "group_budget_applications" ADD CONSTRAINT "group_budget_applications_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "channel_model_cost_rules_channel_model_id_enabled_valid_from_id" RENAME TO "channel_model_cost_rules_channel_model_id_enabled_valid_fro_idx";

ALTER TABLE "group_budget_applications" ADD CONSTRAINT "budget_application_shape" CHECK (
  "requested_cny" > 0 AND "requested_cny" != 'NaN'::numeric
  AND ("approved_cny" IS NULL OR ("approved_cny" >= 0 AND "approved_cny" != 'NaN'::numeric))
  AND (
    ("status" = 'REGISTERED' AND "approved_cny" IS NULL AND "decided_by_id" IS NULL AND "decided_at" IS NULL AND "linked_entry_id" IS NULL)
    OR ("status" = 'LINKED' AND "approved_cny" IS NOT NULL AND "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "linked_entry_id" IS NOT NULL)
    OR ("status" = 'REJECTED' AND "approved_cny" IS NULL AND "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "linked_entry_id" IS NULL)
  )
);

COMMIT;
