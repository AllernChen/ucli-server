ALTER TABLE "channel_model_cost_rules"
  DROP CONSTRAINT "channel_model_cost_rules_currency_check";

ALTER TABLE "channel_model_cost_rules"
  ADD CONSTRAINT "channel_model_cost_rules_currency_check"
  CHECK ("deleted_at" IS NOT NULL OR "currency" = 'CNY');
