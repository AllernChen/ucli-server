UPDATE "usage_logs"
SET "cost_usd" = ROUND((
      GREATEST("input_tokens" - "cached_tokens", 0)::numeric * 3
      + GREATEST("output_tokens" - "reasoning_tokens", 0)::numeric * 6
      + "cached_tokens"::numeric * 0.025
      + "reasoning_tokens"::numeric * 6
    ) / 1000000, 8),
    "cost_snapshot" = "cost_snapshot" || jsonb_build_object(
      'legacyCurrency', "cost_snapshot"->>'currency',
      'legacyCost', "cost_usd"::text,
      'legacyPriceSnapshot', "cost_snapshot",
      'currency', 'CNY',
      'inputPerMillion', '3',
      'outputPerMillion', '6',
      'cachedPerMillion', '0.025',
      'reasoningPerMillion', '6'
    )
WHERE "public_model_id" = 'deepseek-v4-pro'
  AND "cost_snapshot"->>'currency' = 'USD'
  AND "cost_snapshot"->>'inputPerMillion' IN ('0.435', '0.43500000')
  AND "cost_snapshot"->>'outputPerMillion' IN ('0.87', '0.87000000')
  AND "cost_snapshot"->>'cachedPerMillion' IN ('0.003625', '0.00362500');
