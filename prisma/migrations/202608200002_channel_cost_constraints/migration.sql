ALTER TABLE "channel_model_cost_rules"
  ALTER COLUMN "days_of_week" SET NOT NULL,
  ADD CONSTRAINT "channel_model_cost_rules_days_check"
    CHECK (cardinality("days_of_week") BETWEEN 1 AND 7 AND "days_of_week" <@ ARRAY[1,2,3,4,5,6,7]),
  ADD CONSTRAINT "channel_model_cost_rules_minutes_check"
    CHECK ("start_minute" BETWEEN 0 AND 1439 AND "end_minute" BETWEEN 0 AND 1439),
  ADD CONSTRAINT "channel_model_cost_rules_amounts_check"
    CHECK ("input_per_million" >= 0 AND "output_per_million" >= 0 AND
      "cached_per_million" >= 0 AND "reasoning_per_million" >= 0),
  ADD CONSTRAINT "channel_model_cost_rules_currency_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "channel_model_cost_rules_validity_check"
    CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from");
