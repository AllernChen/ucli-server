import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('platform CNY migration', () => {
  const migration = readFileSync(
    join(process.cwd(), 'prisma/migrations/202608210004_platform_cny_currency/migration.sql'),
    'utf8',
  );

  it('requires CNY for active rules while preserving archived legacy currency history', () => {
    const dropPosition = migration.indexOf('DROP CONSTRAINT "channel_model_cost_rules_currency_check"');
    const updatePosition = migration.indexOf('UPDATE "channel_model_cost_rules"');

    expect(dropPosition).toBeGreaterThanOrEqual(0);
    expect(updatePosition).toBeGreaterThan(dropPosition);
    expect(migration).toContain(
      'CHECK ("deleted_at" IS NOT NULL OR "currency" = \'CNY\')',
    );
  });

  it('keeps restored fallback prices inactive until an explicit activation', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');

    expect(schema).toMatch(/model ModelPriceVersion[\s\S]*enabled\s+Boolean\s+@default\(true\)/);
  });
});
