import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729064000_public_token_trader_rankings_authority.sql'
  ),
  'utf8'
)

describe('public token trader ranking authority RPC', () => {
  it('adds a new exact-allowlist RPC without weakening the legacy contract', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.get_public_token_trader_rankings('
    )
    expect(migration).not.toContain('DROP FUNCTION public.get_token_trader_rankings')
    expect(migration).toContain('allowed_sources text[]')
    expect(migration).toContain('pg_catalog.cardinality(allowed_sources) > 256')
    expect(migration).toContain("input.source !~ '^[a-z0-9]+(_[a-z0-9]+)*$'")
    expect(migration).toContain('pg_catalog.count(*) <> pg_catalog.count(DISTINCT input.source)')
  })

  it('filters source authority before total_count and finite pagination', () => {
    const allowedJoin = migration.indexOf('JOIN allowed')
    const countWindow = migration.indexOf('pg_catalog.count(*) OVER ()')
    const finalLimit = migration.indexOf('LIMIT max_traders')

    expect(allowedJoin).toBeGreaterThan(-1)
    expect(countWindow).toBeGreaterThan(allowedJoin)
    expect(finalLimit).toBeGreaterThan(countWindow)
    expect(migration).toContain('ON allowed.source = daily.source')
  })

  it('uses a deterministic total order across equal-PnL page boundaries', () => {
    expect(migration).toContain(
      'ORDER BY counted.token_pnl DESC, counted.source ASC, counted.source_trader_id ASC'
    )
  })

  it('is bounded, invoker-safe, service-only, and reloads PostgREST', () => {
    expect(migration).toContain('SECURITY INVOKER')
    expect(migration).toContain('SET search_path = pg_catalog, public, pg_temp')
    expect(migration).toContain(') FROM PUBLIC, anon, authenticated;')
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_public_token_trader_rankings\([\s\S]*?\) TO service_role;/
    )
    expect(migration).toContain("ERRCODE = '22023'")
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
