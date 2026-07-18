import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260718134000_freshness_expected_sources.sql'),
  'utf8'
)

describe('freshness expected sources RPC', () => {
  it('uses active serving registry promises without a data-dependent join', () => {
    expect(migration).toContain("source_row.status = 'active'")
    expect(migration).toContain("source_row.serving_mode = 'serving'")
    expect(migration).toContain('source_row.timeframes_native || source_row.timeframes_derived')
    expect(migration).toContain('declared.day_count IN (7, 30, 90)')
    expect(migration).not.toMatch(
      /leaderboard_(?:ranks|count_cache|source_freshness)|leaderboard_snapshots/
    )
  })

  it('keeps registry identity separate from the public freshness alias', () => {
    expect(migration).toContain('source_row.slug AS registry_slug')
    expect(migration).toContain("source_row.meta->>'legacy_platform'")
    expect(migration).toContain("NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), '')")
    expect(migration).toContain("<> 'null'")
    expect(migration).toContain('AS filter_source')
    expect(migration).toContain('exchange_row.name AS exchange_name')
    expect(migration).toContain("(timeframe.day_count::text || 'D') AS season_id")
  })

  it('is a bounded read-only definer function with explicit grants', () => {
    expect(migration).toContain('LANGUAGE sql')
    expect(migration).toContain('STABLE')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = public, arena, pg_temp')
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.arena_freshness_expected_sources()'
    )
    expect(migration).toContain('FROM PUBLIC, anon, authenticated')
    expect(migration).toContain('TO service_role')
    expect(migration).not.toContain('TO anon, authenticated')
  })
})
