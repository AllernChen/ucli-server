-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "pending_credential_change" BOOLEAN NOT NULL DEFAULT false;
