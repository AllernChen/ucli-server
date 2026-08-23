ALTER TABLE "model_price_versions"
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

UPDATE "model_price_versions"
SET "enabled" = false
WHERE "deleted_at" IS NOT NULL;

CREATE INDEX "model_prices_runtime_idx"
  ON "model_price_versions"("public_model_id", "deleted_at", "enabled", "valid_from");
