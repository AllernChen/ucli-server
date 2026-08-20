-- Promote channel abilities to first-class channel models.
CREATE TYPE "ModelHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY', 'DISABLED');

ALTER TABLE "channels" ADD COLUMN "cost_timezone" TEXT NOT NULL DEFAULT 'UTC';

ALTER TABLE "channel_abilities" RENAME TO "channel_models";
ALTER TABLE "channel_models" DROP CONSTRAINT "channel_abilities_pkey";
ALTER TABLE "channel_models" ADD COLUMN "id" UUID;
UPDATE "channel_models" SET "id" = gen_random_uuid();
ALTER TABLE "channel_models" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "channel_models"
  ADD COLUMN "health" "ModelHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "probe_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "probe_interval_minutes" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "last_tested_at" TIMESTAMP(3),
  ADD COLUMN "last_success_at" TIMESTAMP(3),
  ADD COLUMN "last_error_code" TEXT;
UPDATE "channel_models" AS model
SET "health" = channel."health"::text::"ModelHealthStatus",
    "last_tested_at" = channel."last_tested_at",
    "last_success_at" = channel."last_success_at"
FROM "channels" AS channel
WHERE channel."id" = model."channel_id";
ALTER TABLE "channel_models" ADD CONSTRAINT "channel_models_pkey" PRIMARY KEY ("id");
ALTER TABLE "channel_models" ADD CONSTRAINT "channel_models_channel_id_public_model_id_protocol_key"
  UNIQUE ("channel_id", "public_model_id", "protocol");
DROP INDEX "channel_abilities_public_model_id_protocol_enabled_idx";
CREATE INDEX "channel_models_public_model_id_protocol_enabled_health_idx"
  ON "channel_models"("public_model_id", "protocol", "enabled", "health");

CREATE TABLE "channel_model_cost_rules" (
  "id" UUID NOT NULL,
  "channel_model_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "days_of_week" INTEGER[],
  "start_minute" INTEGER NOT NULL,
  "end_minute" INTEGER NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "input_per_million" DECIMAL(20,8) NOT NULL,
  "output_per_million" DECIMAL(20,8) NOT NULL,
  "cached_per_million" DECIMAL(20,8) NOT NULL DEFAULT 0,
  "reasoning_per_million" DECIMAL(20,8) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "valid_from" TIMESTAMP(3) NOT NULL,
  "valid_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "channel_model_cost_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "channel_model_cost_rules_channel_model_id_enabled_valid_from_idx"
  ON "channel_model_cost_rules"("channel_model_id", "enabled", "valid_from");
ALTER TABLE "channel_model_cost_rules" ADD CONSTRAINT "channel_model_cost_rules_channel_model_id_fkey"
  FOREIGN KEY ("channel_model_id") REFERENCES "channel_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "channel_model_probes" (
  "id" UUID NOT NULL,
  "channel_model_id" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "health" "ModelHealthStatus" NOT NULL,
  "status_code" INTEGER,
  "latency_ms" INTEGER NOT NULL,
  "first_token_ms" INTEGER,
  "error_code" TEXT,
  "key_suffix" TEXT,
  "tested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "channel_model_probes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "channel_model_probes_channel_model_id_tested_at_idx"
  ON "channel_model_probes"("channel_model_id", "tested_at");
ALTER TABLE "channel_model_probes" ADD CONSTRAINT "channel_model_probes_channel_model_id_fkey"
  FOREIGN KEY ("channel_model_id") REFERENCES "channel_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "usage_logs"
  ADD COLUMN "channel_model_id" UUID,
  ADD COLUMN "channel_cost_rule_id" UUID,
  ADD COLUMN "cost_snapshot" JSONB;

UPDATE "usage_logs" AS usage
SET "channel_model_id" = (
  SELECT model."id"
  FROM "channel_models" AS model
  WHERE model."channel_id" = usage."channel_id"
    AND model."public_model_id" = usage."public_model_id"
    AND (model."protocol" = usage."protocol" OR (usage."protocol" = 'OPENAI_CHAT' AND model."protocol" = 'GEMINI'))
  ORDER BY CASE WHEN model."protocol" = usage."protocol" THEN 0 ELSE 1 END
  LIMIT 1
);

UPDATE "usage_logs" AS usage
SET "cost_snapshot" = jsonb_build_object(
  'source', 'PUBLIC_MODEL_FALLBACK',
  'inputPerMillion', price."input_per_million"::text,
  'outputPerMillion', price."output_per_million"::text,
  'cachedPerMillion', price."cached_per_million"::text,
  'reasoningPerMillion', price."reasoning_per_million"::text,
  'currency', price."currency",
  'timezone', 'UTC',
  'resolvedAt', usage."started_at"
)
FROM "model_price_versions" AS price
WHERE usage."price_version_id" = price."id";

ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_channel_model_id_fkey"
  FOREIGN KEY ("channel_model_id") REFERENCES "channel_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_channel_cost_rule_id_fkey"
  FOREIGN KEY ("channel_cost_rule_id") REFERENCES "channel_model_cost_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "usage_logs_organization_id_started_at_channel_id_idx"
  ON "usage_logs"("organization_id", "started_at", "channel_id");
CREATE INDEX "usage_logs_organization_id_started_at_public_model_id_idx"
  ON "usage_logs"("organization_id", "started_at", "public_model_id");
CREATE INDEX "usage_logs_organization_id_started_at_account_id_idx"
  ON "usage_logs"("organization_id", "started_at", "account_id");
CREATE INDEX "usage_logs_organization_id_started_at_channel_model_id_idx"
  ON "usage_logs"("organization_id", "started_at", "channel_model_id");
