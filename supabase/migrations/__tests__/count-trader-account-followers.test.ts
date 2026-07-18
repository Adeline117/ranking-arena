import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260718130000_count_trader_account_followers.sql'),
  'utf8'
)

describe('source-scoped trader follower count RPC', () => {
  it('keeps the legacy RPC intact and adds a bounded account contract', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.count_trader_account_followers')
    expect(migration).not.toContain('DROP FUNCTION count_trader_followers')
    expect(migration).toContain('pg_catalog.cardinality(p_trader_ids)')
    expect(migration).toContain('> 1000')
    expect(migration).toContain('non-empty trader id and source')
  })

  it('counts by exact trader id and source without duplicating requested accounts', () => {
    expect(migration).toContain('SELECT DISTINCT')
    expect(migration).toContain('follow_row.trader_id = requested.trader_id')
    expect(migration).toContain('follow_row.source = requested.source')
    expect(migration).toContain('GROUP BY requested.trader_id, requested.source')
    expect(migration).not.toMatch(/GROUP BY\s+follow_row\.trader_id\s*;/)
  })

  it('is invoker-safe, schema-bounded, and reloads the API schema', () => {
    expect(migration).toContain('SECURITY INVOKER')
    expect(migration).toContain('SET search_path = pg_catalog, public, pg_temp')
    expect(migration).toContain('REVOKE ALL ON FUNCTION')
    expect(migration).toContain('TO anon, authenticated, service_role')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
