ALTER TABLE "public_models"
  ADD COLUMN "manufacturer" TEXT NOT NULL DEFAULT '未分类',
  ADD COLUMN "manufacturer_key" TEXT NOT NULL DEFAULT '未分类';

UPDATE "public_models"
SET "manufacturer" = CASE
      WHEN lower("id") LIKE 'deepseek%' THEN 'DeepSeek'
      WHEN lower("id") LIKE 'claude%' THEN 'Anthropic'
      WHEN lower("id") LIKE 'gemini%' THEN 'Google'
      WHEN lower("id") LIKE 'gpt%' OR lower("id") ~ '^o[1-9]' THEN 'OpenAI'
      ELSE '未分类'
    END,
    "manufacturer_key" = CASE
      WHEN lower("id") LIKE 'deepseek%' THEN 'deepseek'
      WHEN lower("id") LIKE 'claude%' THEN 'anthropic'
      WHEN lower("id") LIKE 'gemini%' THEN 'google'
      WHEN lower("id") LIKE 'gpt%' OR lower("id") ~ '^o[1-9]' THEN 'openai'
      ELSE '未分类'
    END;

CREATE INDEX "public_models_manufacturer_lifecycle_idx"
  ON "public_models"("manufacturer_key", "deleted_at", "enabled");
