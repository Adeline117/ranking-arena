import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260718182917_arena_resolver_fetch_region.sql'),
  'utf8'
)

describe('arena_resolve_trader Tier-C routing contract', () => {
  it('returns fetchRegion from the same source row as the resolved identity', () => {
    expect(migration).toContain("'fetchRegion', source_row.fetch_region")
    expect(migration).toContain("'source', source_row.slug")
    expect(migration).toContain('source_row.id = trader_row.source_id')
    expect(migration).toContain("source_row.meta ->> 'legacy_platform' = p_source")
  })

  it('keeps the resolver bounded and hardened', () => {
    expect(migration).toContain('STABLE')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = public, arena, pg_temp')
    expect(migration).toContain('LIMIT 1')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.arena_resolve_trader(text, text)')
    expect(migration).toContain('TO anon, authenticated, service_role')
  })
})
