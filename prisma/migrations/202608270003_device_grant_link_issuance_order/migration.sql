BEGIN;

CREATE SEQUENCE "device_grant_links_issuance_order_seq";

ALTER TABLE "device_grant_links" ADD COLUMN "issuance_order" BIGINT;

-- Pre-sequence rows have no issuance record. Lifecycle timestamps are the
-- authoritative historical fallback; a current link always ranks newest.
WITH ranked_links AS (
  SELECT
    l."id",
    ROW_NUMBER() OVER (
      ORDER BY
        l."device_grant_id",
        CASE WHEN l."revoked_at" IS NULL AND l."consumed_at" IS NULL THEN 1 ELSE 0 END,
        COALESCE(l."consumed_at", l."revoked_at", l."created_at"),
        l."created_at",
        l."id"
    ) AS "issuance_order"
  FROM "device_grant_links" l
)
UPDATE "device_grant_links" AS l
SET "issuance_order" = ranked_links."issuance_order"
FROM ranked_links
WHERE ranked_links."id" = l."id";

SELECT setval(
  '"device_grant_links_issuance_order_seq"'::regclass,
  COALESCE((SELECT MAX("issuance_order") FROM "device_grant_links"), 1),
  EXISTS(SELECT 1 FROM "device_grant_links")
);

ALTER TABLE "device_grant_links" ALTER COLUMN "issuance_order" SET DEFAULT nextval('"device_grant_links_issuance_order_seq"'::regclass);
ALTER SEQUENCE "device_grant_links_issuance_order_seq" OWNED BY "device_grant_links"."issuance_order";
ALTER TABLE "device_grant_links" ALTER COLUMN "issuance_order" SET NOT NULL;

CREATE UNIQUE INDEX "device_grant_links_issuance_order_key" ON "device_grant_links"("issuance_order");
CREATE INDEX "device_grant_links_device_grant_id_issuance_order_idx" ON "device_grant_links"("device_grant_id", "issuance_order");

COMMIT;
