BEGIN;

CREATE SEQUENCE "device_grant_links_issuance_order_seq";

ALTER TABLE "device_grant_links" ADD COLUMN "issuance_order" BIGINT;
ALTER TABLE "device_grant_links" ALTER COLUMN "issuance_order" SET DEFAULT nextval('"device_grant_links_issuance_order_seq"'::regclass);
UPDATE "device_grant_links" SET "issuance_order" = nextval('"device_grant_links_issuance_order_seq"'::regclass) WHERE "issuance_order" IS NULL;
ALTER TABLE "device_grant_links" ALTER COLUMN "issuance_order" SET NOT NULL;
ALTER SEQUENCE "device_grant_links_issuance_order_seq" OWNED BY "device_grant_links"."issuance_order";

CREATE UNIQUE INDEX "device_grant_links_issuance_order_key" ON "device_grant_links"("issuance_order");
CREATE INDEX "device_grant_links_device_grant_id_issuance_order_idx" ON "device_grant_links"("device_grant_id", "issuance_order");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "device_grants" g
    WHERE NOT EXISTS (SELECT 1 FROM "device_grant_links" l WHERE l."device_grant_id" = g."id")
  ) THEN
    RAISE EXCEPTION 'device grant link backfill incomplete';
  END IF;
END $$;

ALTER TABLE "device_grants" DROP COLUMN "token_hash", DROP COLUMN "token_hint";

COMMIT;
