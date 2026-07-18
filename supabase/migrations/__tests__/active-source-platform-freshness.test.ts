import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260718132000_active_source_platform_freshness.sql'),
  'utf8'
)

describe('active-source platform freshness migration', () => {
  it('drives membership from active arena sources and preserves missing snapshots', () => {
    expect(migration).toContain('FROM arena.sources AS source_row')
    expect(migration).toContain('LEFT JOIN arena.leaderboard_snapshots AS snapshot')
    expect(migration).toContain("WHERE source_row.status = 'active'")
    expect(migration).toContain('max(snapshot.scraped_at) AS latest')
    expect(migration).toContain('GROUP BY source_row.id')
    expect(migration).not.toContain('SOURCES_WITH_DATA')
    expect(migration).not.toMatch(/FROM\s+arena\.leaderboard_snapshots\s+AS\s+snapshot\s+JOIN/i)
  })

  it('keeps the existing two-column RPC contract and canonical alias fallback', () => {
    expect(migration).toContain('RETURNS TABLE(source text, latest timestamptz)')
    expect(migration).toContain("NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), '')")
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_platform_freshness()')
  })

  it('is invoker-safe, service-role-only, and atomic', () => {
    expect(migration).toContain('SECURITY INVOKER')
    expect(migration).toContain("SET search_path TO 'pg_catalog', 'pg_temp'")
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.get_platform_freshness() FROM PUBLIC, anon, authenticated'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.get_platform_freshness() TO service_role'
    )
    expect(migration).toMatch(/\nBEGIN;\n/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\s+(?:INTO|TABLE|FROM)\b/
    )
  })
})
