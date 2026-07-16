import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716071500_visible_leaderboard_sources.sql'),
  'utf8'
)

describe('visible leaderboard sources RPC', () => {
  it('separates registry identity from the public filter source', () => {
    expect(migration).toContain('source_row.slug AS registry_slug')
    expect(migration).toContain("source_row.meta->>'legacy_platform'")
    expect(migration).toContain('AS filter_source')
    expect(migration).toContain('exchange_row.slug AS exchange_slug')
    expect(migration).toContain('source_row.product_type')
  })

  it('requires the current score-visible generation and serving registry state', () => {
    expect(migration).toContain("source = '_all_gt0'")
    expect(migration).toContain("|| '_gt0'")
    expect(migration).toContain('generation.updated_at = count_row.updated_at')
    expect(migration).toContain("source_row.status = 'active'")
    expect(migration).toContain("source_row.serving_mode = 'serving'")
    expect(migration).toContain('count_row.total_count > 0')
    expect(migration).toContain("p_season_id IN ('7D', '30D', '90D')")
  })

  it('is a bounded read-only definer function with explicit grants', () => {
    expect(migration).toContain('LANGUAGE sql')
    expect(migration).toContain('STABLE')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = public, arena, pg_temp')
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.arena_visible_sources(text) TO anon, authenticated, service_role'
    )
  })
})
