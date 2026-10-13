import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260817000000_finalize_trader_alert_delivery_epoch_fence.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const functionStart = migration.indexOf(
  'CREATE OR REPLACE FUNCTION public.finalize_trader_alert_delivery('
)
const functionEnd = migration.indexOf('REVOKE ALL ON FUNCTION', functionStart)

if (functionStart < 0 || functionEnd < 0) {
  throw new Error('missing finalize_trader_alert_delivery replacement')
}

const functionBody = migration.slice(functionStart, functionEnd)

describe('finalize trader alert delivery epoch fence migration', () => {
  it('is a forward transactional replacement after the public-ranking authority', () => {
    expect(migrationName).toMatch(/^\d{14}_finalize_trader_alert_delivery_epoch_fence\.sql$/)
    expect(
      migrationName > '20260816184500_public_ranked_leaderboard_source_freshness_gate.sql'
    ).toBe(true)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'")
    expect(migration).toContain("SET LOCAL TIME ZONE 'UTC'")
  })

  it('locks and rejects unsealed deliveries before every durable side effect', () => {
    const lock = functionBody.indexOf('FOR UPDATE;')
    const missingDelivery = functionBody.indexOf(
      "RAISE EXCEPTION 'trader alert delivery % not found'"
    )
    const epochFence = functionBody.indexOf('IF delivery.baseline_version < 1000000000 THEN')

    expect(lock).toBeGreaterThan(-1)
    expect(missingDelivery).toBeGreaterThan(lock)
    expect(epochFence).toBeGreaterThan(missingDelivery)
    expect(functionBody).toContain("'trader alert delivery % has unsealed baseline version %'")

    for (const write of [
      'INSERT INTO public.notifications',
      'INSERT INTO public.trader_alert_logs',
      'INSERT INTO public.alert_history',
      'INSERT INTO public.trader_alert_states',
      'UPDATE public.trader_alert_deliveries',
      'UPDATE public.trader_alerts',
    ]) {
      expect(functionBody.indexOf(write)).toBeGreaterThan(epochFence)
    }
  })

  it('preserves the service-only security-definer execution contract', () => {
    expect(functionBody).toMatch(
      /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public, pg_temp/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.finalize_trader_alert_delivery\(uuid, numeric, timestamptz\)\s+FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.finalize_trader_alert_delivery\(uuid, numeric, timestamptz\)\s+TO service_role;/
    )
  })
})
