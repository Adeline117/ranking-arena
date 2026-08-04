import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260803211000_b2c_activation_v2.sql'),
  'utf8'
)

describe('B2C activation v2 contract', () => {
  it('starts a new versioned measurement epoch', () => {
    expect(migration).toContain("'activation_7d'")
    expect(migration).toContain("'v2_detail_retention_two_utc_days'")
    expect(migration).toContain("'activation_measurement_started_at'")
    expect(migration).toContain('profile.created_at >= GREATEST(')
  })

  it('requires product intent on two dates inside an exact 7x24h window', () => {
    expect(migration).toContain("event.event_name = 'view_trader'")
    expect(migration).toContain("'save_trader'")
    expect(migration).toContain("'follow_trader'")
    expect(migration).toContain("event.properties ->> 'step' = 'persisted'")
    expect(migration).toContain("event.occurred_at < cohort.created_at + interval '7 days'")
    expect(migration).toContain("AT TIME ZONE 'UTC'")
    expect(migration).toContain('activation_user.action_dates >= 2')
    expect(migration).not.toMatch(/count\(DISTINCT d\.activity_date\)/)
  })

  it('keeps the metric authority service-only', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain(
      'ALTER TABLE public.product_metric_epochs ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role')
    expect(migration).toContain(
      'GRANT SELECT ON TABLE public.product_metric_epochs TO service_role'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.b2c_product_metrics(integer) TO service_role'
    )
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).not.toContain('SET search_path = pg_catalog, public, pg_temp')
    expect(migration).toContain(
      "procedure.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]"
    )
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('has_table_privilege')
    expect(migration).toContain('has_function_privilege')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
