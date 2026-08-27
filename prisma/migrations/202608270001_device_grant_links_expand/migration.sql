BEGIN;

CREATE TABLE "device_grant_links" (
    "id" UUID NOT NULL,
    "device_grant_id" UUID NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "secret_encrypted" JSONB,
    "secret_hint" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_grant_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_grant_links_secret_hash_key" ON "device_grant_links"("secret_hash");
CREATE INDEX "device_grant_links_device_grant_id_created_at_idx" ON "device_grant_links"("device_grant_id", "created_at");
CREATE UNIQUE INDEX "device_grant_links_one_current_per_grant"
  ON "device_grant_links" ("device_grant_id")
  WHERE "revoked_at" IS NULL AND "consumed_at" IS NULL;

ALTER TABLE "device_grant_links" ADD CONSTRAINT "device_grant_links_device_grant_id_fkey"
  FOREIGN KEY ("device_grant_id") REFERENCES "device_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_grant_links" ADD CONSTRAINT "device_grant_links_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Legacy grant credentials cannot be recovered as links. Retain only an inert
-- historical row: bound grants are consumed and unbound grants are revoked.
INSERT INTO "device_grant_links" (
  "id", "device_grant_id", "secret_hash", "secret_encrypted", "secret_hint",
  "expires_at", "revoked_at", "consumed_at", "created_by_id", "created_at"
)
SELECT
  "id", "id", "token_hash", NULL, "token_hint",
  NULL,
  CASE WHEN "device_id" IS NULL THEN CURRENT_TIMESTAMP ELSE NULL END,
  CASE WHEN "device_id" IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
  "created_by_id", "created_at"
FROM "device_grants";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "device_grants" AS device_grant
    WHERE NOT EXISTS (
      SELECT 1
      FROM "device_grant_links" AS link
      WHERE link."device_grant_id" = device_grant."id"
    )
  ) THEN
    RAISE EXCEPTION 'Every device grant must have historical link evidence';
  END IF;
END $$;

COMMIT;
