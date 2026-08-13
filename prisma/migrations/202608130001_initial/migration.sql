-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PLATFORM_ADMIN', 'ORG_ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "DeviceCodeStatus" AS ENUM ('PENDING', 'APPROVED', 'CONSUMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ChannelProtocol" AS ENUM ('OPENAI', 'ANTHROPIC');

-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'DISABLED');

-- CreateEnum
CREATE TYPE "KeySelection" AS ENUM ('ROUND_ROBIN', 'WEIGHTED_RANDOM');

-- CreateEnum
CREATE TYPE "GatewayProtocol" AS ENUM ('OPENAI_RESPONSES', 'OPENAI_CHAT', 'ANTHROPIC_MESSAGES');

-- CreateEnum
CREATE TYPE "UsageSource" AS ENUM ('UPSTREAM', 'ESTIMATED');

-- CreateEnum
CREATE TYPE "SkillVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DEPRECATED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SkillVisibility" AS ENUM ('GLOBAL', 'ORGANIZATIONS');

-- CreateEnum
CREATE TYPE "ReportPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR');

-- CreateEnum
CREATE TYPE "ReportScope" AS ENUM ('PLATFORM', 'ORGANIZATION', 'ACCOUNT', 'MODEL', 'CHANNEL');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "token_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("organization_id","account_id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "invited_by_id" UUID NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_authorizations" (
    "id" UUID NOT NULL,
    "device_code_hash" TEXT NOT NULL,
    "user_code" TEXT NOT NULL,
    "status" "DeviceCodeStatus" NOT NULL DEFAULT 'PENDING',
    "account_id" UUID,
    "device_name" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "interval_seconds" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "protocol" "ChannelProtocol" NOT NULL,
    "base_url" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "auto_disable" BOOLEAN NOT NULL DEFAULT true,
    "timeout_ms" INTEGER NOT NULL DEFAULT 300000,
    "max_retries" INTEGER NOT NULL DEFAULT 1,
    "key_selection" "KeySelection" NOT NULL DEFAULT 'WEIGHTED_RANDOM',
    "health" "HealthStatus" NOT NULL DEFAULT 'HEALTHY',
    "circuit_open_until" TIMESTAMP(3),
    "last_tested_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_keys" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "suffix" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "health" "HealthStatus" NOT NULL DEFAULT 'HEALTHY',
    "remaining_usd" DECIMAL(20,8),
    "expires_at" TIMESTAMP(3),
    "isolated_until" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "channel_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_models" (
    "id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "context_size" INTEGER,

    CONSTRAINT "public_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_abilities" (
    "channel_id" UUID NOT NULL,
    "public_model_id" TEXT NOT NULL,
    "upstream_model" TEXT NOT NULL,
    "protocol" "GatewayProtocol" NOT NULL,
    "supports_stream" BOOLEAN NOT NULL DEFAULT true,
    "supports_tools" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "channel_abilities_pkey" PRIMARY KEY ("channel_id","public_model_id","protocol")
);

-- CreateTable
CREATE TABLE "model_price_versions" (
    "id" UUID NOT NULL,
    "public_model_id" TEXT NOT NULL,
    "input_per_million" DECIMAL(20,8) NOT NULL,
    "output_per_million" DECIMAL(20,8) NOT NULL,
    "cached_per_million" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "reasoning_per_million" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3),

    CONSTRAINT "model_price_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_access_policies" (
    "id" UUID NOT NULL,
    "public_model_id" TEXT NOT NULL,
    "organization_id" UUID,
    "account_id" UUID,
    "role" "Role",

    CONSTRAINT "model_access_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "account_id" UUID,
    "public_model_id" TEXT,
    "daily_tokens" BIGINT,
    "monthly_tokens" BIGINT,
    "daily_cost_usd" DECIMAL(20,8),
    "monthly_cost_usd" DECIMAL(20,8),
    "qps" INTEGER,
    "tpm" BIGINT,
    "concurrency" INTEGER,

    CONSTRAINT "quota_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_logs" (
    "id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "session_id" UUID,
    "project_id" UUID,
    "cli_type" TEXT,
    "client_version" TEXT,
    "timezone" TEXT,
    "protocol" "GatewayProtocol" NOT NULL,
    "public_model_id" TEXT NOT NULL,
    "upstream_model" TEXT NOT NULL,
    "channel_id" UUID NOT NULL,
    "price_version_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "first_token_ms" INTEGER,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cached_tokens" BIGINT NOT NULL DEFAULT 0,
    "reasoning_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "usage_source" "UsageSource" NOT NULL,
    "streaming" BOOLEAN NOT NULL,
    "status_code" INTEGER NOT NULL,
    "error_code" TEXT,
    "provider_error_type" TEXT,
    "route_attempts" INTEGER NOT NULL DEFAULT 1,
    "switched" BOOLEAN NOT NULL DEFAULT false,
    "client_cancelled" BOOLEAN NOT NULL DEFAULT false,
    "stream_interrupted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_attempts" (
    "id" UUID NOT NULL,
    "usage_log_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "channel_key_id" UUID,
    "attempt" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "status_code" INTEGER,
    "error_type" TEXT,

    CONSTRAINT "route_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_aggregates" (
    "id" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID,
    "account_id" UUID,
    "public_model_id" TEXT,
    "channel_id" UUID,
    "requests" BIGINT NOT NULL,
    "successes" BIGINT NOT NULL,
    "input_tokens" BIGINT NOT NULL,
    "output_tokens" BIGINT NOT NULL,
    "cost_usd" DECIMAL(20,8) NOT NULL,
    "avg_duration_ms" INTEGER NOT NULL,

    CONSTRAINT "usage_aggregates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_versions" (
    "id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "status" "SkillVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "SkillVisibility" NOT NULL DEFAULT 'GLOBAL',
    "object_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "manifest" JSONB NOT NULL,
    "file_manifest" JSONB NOT NULL,
    "scan_result" JSONB NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_organizations" (
    "skill_version_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "skill_organizations_pkey" PRIMARY KEY ("skill_version_id","organization_id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "period" "ReportPeriod" NOT NULL,
    "scope" "ReportScope" NOT NULL,
    "scope_id" TEXT,
    "organization_id" UUID,
    "account_id" UUID,
    "public_model_id" TEXT,
    "channel_id" UUID,
    "range_start" TIMESTAMP(3) NOT NULL,
    "range_end" TIMESTAMP(3) NOT NULL,
    "markdown" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_account_id" UUID,
    "organization_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "metadata" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organization_id_email_idx" ON "invitations"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "devices_refresh_token_hash_key" ON "devices"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "devices_organization_id_account_id_idx" ON "devices"("organization_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_authorizations_device_code_hash_key" ON "device_authorizations"("device_code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "device_authorizations_user_code_key" ON "device_authorizations"("user_code");

-- CreateIndex
CREATE INDEX "channels_enabled_health_priority_idx" ON "channels"("enabled", "health", "priority");

-- CreateIndex
CREATE INDEX "channel_keys_channel_id_enabled_health_idx" ON "channel_keys"("channel_id", "enabled", "health");

-- CreateIndex
CREATE INDEX "channel_abilities_public_model_id_protocol_enabled_idx" ON "channel_abilities"("public_model_id", "protocol", "enabled");

-- CreateIndex
CREATE INDEX "model_price_versions_public_model_id_valid_from_idx" ON "model_price_versions"("public_model_id", "valid_from");

-- CreateIndex
CREATE INDEX "model_access_policies_public_model_id_organization_id_accou_idx" ON "model_access_policies"("public_model_id", "organization_id", "account_id");

-- CreateIndex
CREATE INDEX "quota_policies_organization_id_account_id_public_model_id_idx" ON "quota_policies"("organization_id", "account_id", "public_model_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_logs_request_id_key" ON "usage_logs"("request_id");

-- CreateIndex
CREATE INDEX "usage_logs_organization_id_started_at_idx" ON "usage_logs"("organization_id", "started_at");

-- CreateIndex
CREATE INDEX "usage_logs_account_id_started_at_idx" ON "usage_logs"("account_id", "started_at");

-- CreateIndex
CREATE INDEX "usage_logs_public_model_id_started_at_idx" ON "usage_logs"("public_model_id", "started_at");

-- CreateIndex
CREATE INDEX "usage_logs_channel_id_started_at_idx" ON "usage_logs"("channel_id", "started_at");

-- CreateIndex
CREATE INDEX "usage_logs_session_id_started_at_idx" ON "usage_logs"("session_id", "started_at");

-- CreateIndex
CREATE INDEX "route_attempts_usage_log_id_attempt_idx" ON "route_attempts"("usage_log_id", "attempt");

-- CreateIndex
CREATE INDEX "usage_aggregates_bucket_bucket_start_idx" ON "usage_aggregates"("bucket", "bucket_start");

-- CreateIndex
CREATE UNIQUE INDEX "usage_aggregates_bucket_bucket_start_organization_id_accoun_key" ON "usage_aggregates"("bucket", "bucket_start", "organization_id", "account_id", "public_model_id", "channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "skills_slug_key" ON "skills"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "skill_versions_skill_id_version_key" ON "skill_versions"("skill_id", "version");

-- CreateIndex
CREATE INDEX "reports_scope_scope_id_range_start_idx" ON "reports"("scope", "scope_id", "range_start");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_occurred_at_idx" ON "audit_logs"("organization_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_keys" ADD CONSTRAINT "channel_keys_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_abilities" ADD CONSTRAINT "channel_abilities_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_abilities" ADD CONSTRAINT "channel_abilities_public_model_id_fkey" FOREIGN KEY ("public_model_id") REFERENCES "public_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_price_versions" ADD CONSTRAINT "model_price_versions_public_model_id_fkey" FOREIGN KEY ("public_model_id") REFERENCES "public_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_access_policies" ADD CONSTRAINT "model_access_policies_public_model_id_fkey" FOREIGN KEY ("public_model_id") REFERENCES "public_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_policies" ADD CONSTRAINT "quota_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_policies" ADD CONSTRAINT "quota_policies_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_policies" ADD CONSTRAINT "quota_policies_public_model_id_fkey" FOREIGN KEY ("public_model_id") REFERENCES "public_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_public_model_id_fkey" FOREIGN KEY ("public_model_id") REFERENCES "public_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_price_version_id_fkey" FOREIGN KEY ("price_version_id") REFERENCES "model_price_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_attempts" ADD CONSTRAINT "route_attempts_usage_log_id_fkey" FOREIGN KEY ("usage_log_id") REFERENCES "usage_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_attempts" ADD CONSTRAINT "route_attempts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_attempts" ADD CONSTRAINT "route_attempts_channel_key_id_fkey" FOREIGN KEY ("channel_key_id") REFERENCES "channel_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_organizations" ADD CONSTRAINT "skill_organizations_skill_version_id_fkey" FOREIGN KEY ("skill_version_id") REFERENCES "skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_organizations" ADD CONSTRAINT "skill_organizations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_public_model_id_fkey" FOREIGN KEY ("public_model_id") REFERENCES "public_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
