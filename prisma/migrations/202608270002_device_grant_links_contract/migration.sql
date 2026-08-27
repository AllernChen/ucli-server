BEGIN;

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
