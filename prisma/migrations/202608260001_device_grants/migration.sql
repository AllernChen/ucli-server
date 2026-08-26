BEGIN;

-- Retire legacy credentials without deleting devices referenced by usage logs.
UPDATE "devices" SET "revoked_at" = CURRENT_TIMESTAMP WHERE "revoked_at" IS NULL;

-- Drop foreign keys before removing the legacy authorization tables.
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_organization_id_fkey";
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_invited_by_id_fkey";
ALTER TABLE "device_authorizations" DROP CONSTRAINT "device_authorizations_account_id_fkey";
DROP TABLE "invitations";
DROP TABLE "device_authorizations";
-- Default RESTRICT makes unknown external dependencies abort this whole transaction.
DROP TYPE "DeviceCodeStatus";

ALTER TABLE "accounts" ALTER COLUMN "password_hash" DROP NOT NULL;
ALTER TABLE "memberships" ADD COLUMN "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "devices" ADD COLUMN "installation_id" UUID;
ALTER TABLE "devices" ADD COLUMN "platform" TEXT;
ALTER TABLE "devices" ADD COLUMN "client_version" TEXT;

CREATE UNIQUE INDEX "devices_installation_id_key" ON "devices"("installation_id");

CREATE TABLE "device_grants" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "bound_at" TIMESTAMP(3),
    "redeem_retry_until" TIMESTAMP(3),
    "device_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_grants_token_hash_key" ON "device_grants"("token_hash");
CREATE UNIQUE INDEX "device_grants_device_id_key" ON "device_grants"("device_id");
CREATE INDEX "device_grants_organization_id_account_id_created_at_idx" ON "device_grants"("organization_id", "account_id", "created_at");
CREATE INDEX "device_grants_organization_id_deleted_at_expires_at_idx" ON "device_grants"("organization_id", "deleted_at", "expires_at");

ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
