-- Converge usage groups into organization semantics and add department budget projects.
BEGIN;

CREATE TYPE "OrgUnitType" AS ENUM ('EXECUTIVE', 'FUNCTIONAL', 'REGION', 'LEGACY_PROJECT');
CREATE TYPE "ProjectCategory" AS ENUM ('BUSINESS', 'DEPARTMENT');

ALTER TABLE "usage_groups"
  ADD COLUMN "org_type" "OrgUnitType" NOT NULL DEFAULT 'LEGACY_PROJECT';
ALTER TABLE "projects"
  ADD COLUMN "category" "ProjectCategory" NOT NULL DEFAULT 'BUSINESS';
ALTER TABLE "group_members"
  ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "project_budget_applications"
  ADD COLUMN "self_approved" BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "usage_groups"
SET "org_type" = 'REGION'
WHERE "type" = 'REGION' AND "name" <> '研发部';

UPDATE "usage_groups"
SET "org_type" = 'FUNCTIONAL'
WHERE "type" = 'DEPARTMENT' OR "name" = '研发部';

UPDATE "usage_groups"
SET "org_type" = 'LEGACY_PROJECT'
WHERE "type" = 'PROJECT';

INSERT INTO "usage_groups"
  ("id", "organization_id", "name", "type", "org_type", "description", "budget_mode", "budget_timezone",
   "enabled", "unlimited", "default_limit_cny", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", '工程部', 'DEPARTMENT', 'FUNCTIONAL',
  '工程项目与工程日常支持部门', 'TOTAL', 'Asia/Shanghai', TRUE, FALSE, 0,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "organizations" o
WHERE NOT EXISTS (
  SELECT 1 FROM "usage_groups" g
  WHERE g."organization_id" = o."id" AND g."name" = '工程部'
);

INSERT INTO "usage_groups"
  ("id", "organization_id", "name", "type", "org_type", "description", "budget_mode", "budget_timezone",
   "enabled", "unlimited", "default_limit_cny", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", '公司经营层', 'DEPARTMENT', 'EXECUTIVE',
  '公司经营管理与经营分析', 'TOTAL', 'Asia/Shanghai', TRUE, FALSE, 0,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "organizations" o
WHERE NOT EXISTS (
  SELECT 1 FROM "usage_groups" g
  WHERE g."organization_id" = o."id" AND g."name" = '公司经营层'
);

-- Historical project groups remain readable for old credentials, but are no longer primary organizations.
UPDATE "group_members" m
SET "is_primary" = FALSE
FROM "usage_groups" g
WHERE g."id" = m."group_id"
  AND g."type" = 'PROJECT'
  AND m."removed_at" IS NULL;

CREATE TEMP TABLE "target_primary_memberships" (
  "email" TEXT,
  "organization_name" TEXT
) ON COMMIT DROP;

INSERT INTO "target_primary_memberships" VALUES
  ('love0fight@126.com', '公司经营层'),
  ('luo01@ucli.local', '公司经营层'),
  ('wang04@ucli.local', '公司经营层'),
  ('443803527@qq.com', '研发部'),
  ('yaoyilin_yyl@aliyun.com', '研发部'),
  ('he01@ucli.local', '研发部'),
  ('shi01@ucli.local', '研发部'),
  ('602622351@qq.com', '工程部'),
  ('chen02@ucli.local', '工程部'),
  ('wang02@ucli.local', '工程部'),
  ('miao01@ucli.local', '工程部');

DO $$
DECLARE
  missing_targets INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM "organizations") THEN
    SELECT COUNT(*) INTO missing_targets
    FROM "target_primary_memberships" t
    LEFT JOIN "accounts" a ON a."email" = t."email"
    LEFT JOIN "usage_groups" g
      ON g."name" = t."organization_name"
     AND g."organization_id" = (
       SELECT m."organization_id" FROM "memberships" m
       WHERE m."account_id" = a."id"
       ORDER BY m."organization_id" LIMIT 1
     )
    WHERE a."id" IS NULL OR g."id" IS NULL;

    IF missing_targets <> 0 THEN
      RAISE EXCEPTION 'organization convergence target mapping is incomplete: % missing rows', missing_targets;
    END IF;
  END IF;
END $$;

-- Explicit target members lose other non-legacy primary memberships, then gain one new primary organization.
UPDATE "group_members" m
SET "removed_at" = CURRENT_TIMESTAMP, "is_primary" = FALSE
FROM "accounts" a, "usage_groups" g
WHERE m."account_id" = a."id"
  AND g."id" = m."group_id"
  AND m."removed_at" IS NULL
  AND g."type" <> 'PROJECT'
  AND a."email" IN (SELECT "email" FROM "target_primary_memberships");

INSERT INTO "group_members"
  ("organization_id", "group_id", "account_id", "role", "joined_at", "is_primary")
SELECT membership."organization_id", g."id", a."id", 'MEMBER', CURRENT_TIMESTAMP, TRUE
FROM "target_primary_memberships" t
JOIN "accounts" a ON a."email" = t."email"
JOIN "memberships" membership ON membership."account_id" = a."id"
JOIN "usage_groups" g
  ON g."name" = t."organization_name"
 AND g."organization_id" = membership."organization_id"
ON CONFLICT ("group_id", "account_id") DO UPDATE
SET "removed_at" = NULL, "is_primary" = TRUE, "joined_at" = CURRENT_TIMESTAMP, "role" = 'MEMBER';

-- Safety net for databases that predate the explicit target list: keep only the earliest active primary.
WITH ranked AS (
  SELECT m."organization_id", m."group_id", m."account_id", ROW_NUMBER() OVER (
    PARTITION BY m."organization_id", m."account_id"
    ORDER BY m."joined_at", m."group_id"
  ) AS position
  FROM "group_members" m
  JOIN "usage_groups" g ON g."id" = m."group_id"
  WHERE m."removed_at" IS NULL AND g."type" <> 'PROJECT'
)
UPDATE "group_members" m
SET "is_primary" = FALSE
FROM ranked
WHERE ranked."organization_id" = m."organization_id"
  AND ranked."group_id" = m."group_id"
  AND ranked."account_id" = m."account_id"
  AND ranked."position" > 1;

INSERT INTO "projects"
  ("id", "organization_id", "region_id", "code", "name", "description", "status", "category",
   "budget_mode", "budget_timezone", "created_at", "updated_at")
SELECT gen_random_uuid(), g."organization_id", g."id", v."code", v."name", '',
  'ACTIVE', 'DEPARTMENT', 'TOTAL', 'Asia/Shanghai', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('公司经营层', 'DEPT-EXEC', '公司经营层-部门预算'),
  ('研发部', 'DEPT-RD', '研发部-部门预算'),
  ('工程部', 'DEPT-ENG', '工程部-部门预算')
) AS v("organization_name", "code", "name")
JOIN "usage_groups" g ON g."name" = v."organization_name" AND g."org_type" IN ('EXECUTIVE', 'FUNCTIONAL')
WHERE NOT EXISTS (
  SELECT 1 FROM "projects" p
  WHERE p."organization_id" = g."organization_id"
    AND (p."code" = v."code" OR p."name" = v."name")
);

INSERT INTO "project_members"
  ("organization_id", "project_id", "account_id", "role", "created_at", "updated_at")
SELECT g."organization_id", p."id", m."account_id", 'CONTRIBUTOR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "usage_groups" g
JOIN "projects" p ON p."region_id" = g."id" AND p."category" = 'DEPARTMENT'
JOIN "group_members" m ON m."group_id" = g."id" AND m."removed_at" IS NULL AND m."is_primary" = TRUE
ON CONFLICT ("project_id", "account_id") DO NOTHING;

INSERT INTO "group_model_access" ("organization_id", "group_id", "public_model_id")
SELECT target."organization_id", target."id", source."public_model_id"
FROM "group_model_access" source
JOIN "usage_groups" source_group
  ON source_group."id" = source."group_id"
 AND source_group."name" = '研发验收组'
CROSS JOIN "usage_groups" target
WHERE target."name" IN ('公司经营层', '研发部', '工程部')
ON CONFLICT ("group_id", "public_model_id") DO NOTHING;

CREATE UNIQUE INDEX "org_unit_one_active_membership_where_removed_null"
ON "group_members" ("account_id")
WHERE "removed_at" IS NULL AND "is_primary" = TRUE;

CREATE UNIQUE INDEX "one_department_project_per_owner_where_active"
ON "projects" ("organization_id", "region_id")
WHERE "category" = 'DEPARTMENT' AND "status" = 'ACTIVE';

COMMIT;
