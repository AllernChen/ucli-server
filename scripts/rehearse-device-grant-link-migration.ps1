param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'

$Container = 'ucli-device-grant-link-migration-rehearsal'
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$MigrationsDirectory = Join-Path $RepositoryRoot 'prisma/migrations'
$LegacyGrantMigration = '202608260001_device_grants'
$ExpandMigration = '202608270001_device_grant_links_expand'
$ContractMigration = '202608270002_device_grant_links_contract'
$IssuanceOrderMigration = '202608270003_device_grant_link_issuance_order'
$ExpectedCompletenessFailure = 'device grant link backfill incomplete'
$startedContainer = $false
$startedContainerId = $null

function Invoke-Docker {
  param([string[]]$DockerArguments)

  & docker @DockerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($DockerArguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Invoke-Psql {
  param(
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Sql
  )

  $Sql | & docker exec -i $Container psql -U postgres -d $Database -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) {
    throw "psql against $Database failed with exit code $LASTEXITCODE"
  }
}

function Invoke-PsqlExpectFailure {
  param(
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Sql,
    [Parameter(Mandatory = $true)][string]$ExpectedError
  )

  $output = @($Sql | & docker exec -i $Container psql -U postgres -d $Database -v ON_ERROR_STOP=1 2>&1)
  $exitCode = $LASTEXITCODE
  $outputText = $output | Out-String
  $output | ForEach-Object { Write-Output $_ }
  Assert-ExpectedPsqlFailure -ExitCode $exitCode -Output $outputText -ExpectedError $ExpectedError -Database $Database
}

function Assert-ExpectedPsqlFailure {
  param(
    [Parameter(Mandatory = $true)][int]$ExitCode,
    [Parameter(Mandatory = $true)][string]$Output,
    [Parameter(Mandatory = $true)][string]$ExpectedError,
    [Parameter(Mandatory = $true)][string]$Database
  )

  if ($ExitCode -eq 0) {
    throw "psql against $Database unexpectedly succeeded"
  }
  if (-not $Output.Contains($ExpectedError, [System.StringComparison]::Ordinal)) {
    throw "psql against $Database failed unexpectedly with exit code $ExitCode; expected error '$ExpectedError' was absent. Output: $Output"
  }
}

function Invoke-Migration {
  param(
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Path
  )

  Invoke-Docker @('cp', $Path, "${Container}:/tmp/migration.sql")
  Invoke-Docker @('exec', $Container, 'psql', '-U', 'postgres', '-d', $Database, '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/migration.sql')
}

function Get-MigrationPath {
  param([Parameter(Mandatory = $true)][string]$Name)

  $path = Join-Path $MigrationsDirectory "$Name/migration.sql"
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Migration not found: $Name"
  }
  return (Resolve-Path -LiteralPath $path).Path
}

if ($SelfTest) {
  Assert-ExpectedPsqlFailure -ExitCode 1 -Output "ERROR: $ExpectedCompletenessFailure" -ExpectedError $ExpectedCompletenessFailure -Database self-test
  $wrongOutputRejected = $false
  try {
    Assert-ExpectedPsqlFailure -ExitCode 1 -Output 'ERROR: connection refused' -ExpectedError $ExpectedCompletenessFailure -Database self-test
  } catch {
    $wrongOutputRejected = $_.Exception.Message.Contains($ExpectedCompletenessFailure, [System.StringComparison]::Ordinal)
  }
  if (-not $wrongOutputRejected) {
    throw 'Expected-failure self-test did not reject unrelated psql output.'
  }
  Write-Output 'Expected-failure self-test passed: unrelated psql errors are rejected.'
  return
}

try {
  & docker version --format '{{.Server.Version}}' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Docker daemon is unavailable; migration rehearsal cannot run.'
  }

  $existing = & docker ps -aq --filter "name=^/${Container}$"
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to inspect the disposable rehearsal container.'
  }
  if ($existing) {
    $running = & docker inspect --format '{{.State.Running}}' $Container
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to inspect existing rehearsal container $Container."
    }
    if ($running.Trim() -eq 'true') {
      throw "Rehearsal container $Container is already running; refusing to remove a container owned by another invocation."
    }
    Invoke-Docker @('rm', $Container)
  }

  $startedContainerId = (& docker run --name $Container -e 'POSTGRES_PASSWORD=postgres' -d 'postgres:17-alpine').Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "docker run for $Container failed with exit code $LASTEXITCODE"
  }
  if (-not $startedContainerId) {
    throw "docker run for $Container did not return a container ID"
  }
  $startedContainer = $true

  $ready = $false
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    & docker exec $Container pg_isready -U postgres | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) {
    throw 'PostgreSQL did not become ready within 30 seconds.'
  }

  Invoke-Docker @('exec', $Container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE fresh')
  Invoke-Docker @('exec', $Container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE legacy')

  $migrations = @(Get-ChildItem -LiteralPath $MigrationsDirectory -Directory | Sort-Object Name | ForEach-Object {
    $path = Join-Path $_.FullName 'migration.sql'
    if (-not (Test-Path -LiteralPath $path)) { throw "Migration is missing migration.sql: $($_.Name)" }
    [pscustomobject]@{ Name = $_.Name; Path = (Resolve-Path -LiteralPath $path).Path }
  })

  foreach ($migration in $migrations) {
    Invoke-Migration -Database fresh -Path $migration.Path
  }

  foreach ($migration in $migrations) {
    Invoke-Migration -Database legacy -Path $migration.Path
    if ($migration.Name -eq $LegacyGrantMigration) { break }
  }

  Invoke-Psql -Database legacy -Sql @'
INSERT INTO "organizations" ("id", "slug", "name") VALUES
  ('00000000-0000-0000-0000-000000000001', 'migration-rehearsal', 'Migration Rehearsal');
INSERT INTO "accounts" ("id", "email", "display_name", "password_hash") VALUES
  ('00000000-0000-0000-0000-000000000002', 'migration-rehearsal@example.invalid', 'Migration Rehearsal', NULL);
INSERT INTO "memberships" ("organization_id", "account_id", "role") VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'MEMBER');
INSERT INTO "devices" ("id", "organization_id", "account_id", "name", "refresh_token_hash") VALUES
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'Bound rehearsal device', 'refresh-hash-bound');
INSERT INTO "device_grants" (
  "id", "organization_id", "account_id", "token_hash", "token_hint", "device_id", "bound_at", "created_by_id", "updated_at"
) VALUES
  ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'unbound-token-hash', 'unbound-hint', NULL, NULL, '00000000-0000-0000-0000-000000000002', CURRENT_TIMESTAMP),
  ('00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'bound-token-hash', 'bound-hint', '00000000-0000-0000-0000-000000000003', CURRENT_TIMESTAMP, '00000000-0000-0000-0000-000000000002', CURRENT_TIMESTAMP);
'@

  Invoke-Migration -Database legacy -Path (Get-MigrationPath $ExpandMigration)
  Invoke-Migration -Database legacy -Path (Get-MigrationPath $ContractMigration)
  Invoke-Migration -Database legacy -Path (Get-MigrationPath $IssuanceOrderMigration)

  Invoke-Psql -Database fresh -Sql @'
INSERT INTO "organizations" ("id", "slug", "name") VALUES
  ('10000000-0000-0000-0000-000000000001', 'fresh-migration-rehearsal', 'Fresh Migration Rehearsal');
INSERT INTO "accounts" ("id", "email", "display_name") VALUES
  ('10000000-0000-0000-0000-000000000002', 'fresh-migration-rehearsal@example.invalid', 'Fresh Migration Rehearsal');
INSERT INTO "device_grants" ("id", "organization_id", "account_id", "created_by_id", "updated_at") VALUES
  ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', CURRENT_TIMESTAMP);
INSERT INTO "device_grant_links" ("id", "device_grant_id", "secret_hash", "secret_hint", "created_by_id") VALUES
  ('10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000003', 'fresh-first-link-hash', 'fresh-first', '10000000-0000-0000-0000-000000000002');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "device_grant_links" WHERE "issuance_order" <> 1) THEN
    RAISE EXCEPTION 'empty link table did not assign issuance_order 1 to its first link';
  END IF;
END $$;
'@

  Invoke-Psql -Database legacy -Sql @'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "device_grant_links"
    WHERE "device_grant_id" = '00000000-0000-0000-0000-000000000004'
      AND "revoked_at" IS NOT NULL AND "consumed_at" IS NULL AND "secret_encrypted" IS NULL
  ) THEN
    RAISE EXCEPTION 'unbound legacy grant was not converted to revoked null-ciphertext history';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "device_grant_links"
    WHERE "device_grant_id" = '00000000-0000-0000-0000-000000000005'
      AND "consumed_at" IS NOT NULL AND "revoked_at" IS NULL AND "secret_encrypted" IS NULL
  ) THEN
    RAISE EXCEPTION 'bound legacy grant was not converted to consumed null-ciphertext history';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "device_grants" AS device_grant
    WHERE NOT EXISTS (SELECT 1 FROM "device_grant_links" AS link WHERE link."device_grant_id" = device_grant."id")
  ) THEN
    RAISE EXCEPTION 'device grant link backfill is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'device_grants' AND column_name IN ('token_hash', 'token_hint')
  ) THEN
    RAISE EXCEPTION 'legacy device grant credential columns remain after contract migration';
  END IF;
END $$;

INSERT INTO "device_grant_links" ("id", "device_grant_id", "secret_hash", "secret_hint", "created_by_id") VALUES
  ('00000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000004', 'legacy-current-link-hash', 'legacy-current', '00000000-0000-0000-0000-000000000002');

DO $$
DECLARE states TEXT[];
BEGIN
  SELECT array_agg(
    CASE WHEN "revoked_at" IS NULL AND "consumed_at" IS NULL THEN 'CURRENT'
         WHEN "consumed_at" IS NOT NULL THEN 'CONSUMED'
         ELSE 'REVOKED' END
    ORDER BY "issuance_order" DESC
  ) INTO states
  FROM "device_grant_links";
  IF states <> ARRAY['CURRENT', 'CONSUMED', 'REVOKED'] THEN
    RAISE EXCEPTION 'historical links do not select in issuance_order DESC order: %', states;
  END IF;
END $$;

DO $$
DECLARE before_order BIGINT;
DECLARE after_order BIGINT;
BEGIN
  SELECT MAX("issuance_order") INTO before_order FROM "device_grant_links";
  INSERT INTO "device_grant_links" ("id", "device_grant_id", "secret_hash", "secret_hint", "created_by_id") VALUES
    ('00000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000005', 'next-link-hash', 'next-link', '00000000-0000-0000-0000-000000000002')
  RETURNING "issuance_order" INTO after_order;
  IF after_order <> before_order + 1 THEN
    RAISE EXCEPTION 'next link did not receive MAX(issuance_order) + 1';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO "device_grant_links" ("id", "device_grant_id", "secret_hash", "secret_hint", "created_by_id") VALUES
      ('00000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000004', 'duplicate-current-link-hash', 'duplicate-current', '00000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'current-link partial unique index did not reject a duplicate';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM "device_grant_links"
    WHERE "revoked_at" IS NULL AND "consumed_at" IS NULL
    GROUP BY "device_grant_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'more than one current link exists for a device grant';
  END IF;
END $$;
'@

  Invoke-PsqlExpectFailure -Database legacy -ExpectedError $ExpectedCompletenessFailure -Sql @'
BEGIN;
CREATE TABLE "migration_rehearsal_rollback_marker" ("id" INTEGER PRIMARY KEY);
DELETE FROM "device_grant_links" WHERE "device_grant_id" = '00000000-0000-0000-0000-000000000004';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "device_grants" AS device_grant
    WHERE NOT EXISTS (SELECT 1 FROM "device_grant_links" AS link WHERE link."device_grant_id" = device_grant."id")
  ) THEN
    RAISE EXCEPTION 'device grant link backfill incomplete';
  END IF;
END $$;
COMMIT;
'@

  Invoke-Psql -Database legacy -Sql @'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'migration_rehearsal_rollback_marker'
  ) THEN
    RAISE EXCEPTION 'failing migration transaction did not roll back its marker table';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "device_grant_links"
    WHERE "device_grant_id" = '00000000-0000-0000-0000-000000000004'
  ) THEN
    RAISE EXCEPTION 'failing migration transaction did not roll back its link deletion';
  END IF;
END $$;
'@

  Write-Output 'Fresh-install migration path verified, including issuance_order=1 for an empty link table.'
  Write-Output 'Legacy expand/contract/issuance migration path verified, including lifecycle history, ordering, uniqueness, and rollback.'
}
finally {
  if ($startedContainer) {
    & docker rm -f $startedContainerId | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Error "Failed to remove disposable rehearsal container $startedContainerId (exit code $LASTEXITCODE)."
    }
  }
}
