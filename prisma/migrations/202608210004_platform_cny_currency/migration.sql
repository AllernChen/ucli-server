ALTER TABLE "channel_model_cost_rules"
  ALTER COLUMN "currency" SET DEFAULT 'CNY';

ALTER TABLE "model_price_versions"
  ALTER COLUMN "currency" SET DEFAULT 'CNY';

ALTER TABLE "channel_model_cost_rules"
  DROP CONSTRAINT "channel_model_cost_rules_currency_check";

UPDATE "channel_model_cost_rules"
SET "currency" = 'CNY'
WHERE "deleted_at" IS NULL;

ALTER TABLE "channel_model_cost_rules"
  ADD CONSTRAINT "channel_model_cost_rules_currency_check"
  CHECK ("deleted_at" IS NOT NULL OR "currency" = 'CNY');

UPDATE "model_price_versions"
SET "currency" = 'CNY'
WHERE "deleted_at" IS NULL;
