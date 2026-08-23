ALTER TABLE "channels" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "channel_keys" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "public_models" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "channel_models" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "channel_model_cost_rules" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "model_price_versions" ADD COLUMN "deleted_at" TIMESTAMP(3);

CREATE INDEX "channels_deleted_at_enabled_idx" ON "channels"("deleted_at", "enabled");
CREATE INDEX "channel_keys_deleted_at_enabled_idx" ON "channel_keys"("deleted_at", "enabled");
CREATE INDEX "public_models_deleted_at_enabled_idx" ON "public_models"("deleted_at", "enabled");
CREATE INDEX "channel_models_deleted_at_enabled_idx" ON "channel_models"("deleted_at", "enabled");
CREATE INDEX "cm_cost_rules_lifecycle_idx" ON "channel_model_cost_rules"("channel_model_id", "deleted_at", "enabled", "valid_from");
CREATE INDEX "model_prices_lifecycle_idx" ON "model_price_versions"("public_model_id", "deleted_at", "valid_from");
