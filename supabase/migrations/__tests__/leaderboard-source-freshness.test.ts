import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260718120000_leaderboard_source_freshness.sql'),
  'utf8'
)

describe('leaderboard source freshness migration', () => {
  it('is replay-safe and keyed independently for every ranking window and source', () => {
    expect(migration).toContain('BEGIN;')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.leaderboard_source_freshness')
    expect(migration).toContain('PRIMARY KEY (season_id, source)')
    expect(migration).toContain('ON CONFLICT (season_id, source) DO UPDATE')
    expect(migration).toContain("CHECK (season_id IN ('7D', '30D', '90D'))")
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS idx_leaderboard_source_freshness_age')
    expect(migration).toContain('DROP POLICY IF EXISTS "leaderboard_source_freshness_public_read"')
    expect(migration).toContain('leaderboard_source_freshness_not_future')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('backfills from the latest PASSED source scrape and never from score compute time', () => {
    expect(migration).toContain('snapshot.count_check_passed')
    expect(migration).toContain('snapshot.scraped_at')
    expect(migration).toContain('MIN(latest.scraped_at) AS source_as_of')
    expect(migration).not.toMatch(
      /SET\s+source_as_of\s*=\s*(?:ranks|leaderboard_ranks)\.computed_at/i
    )
    expect(migration).not.toMatch(/(?:ranks|leaderboard_ranks)\.computed_at\s+AS\s+source_as_of/i)
  })

  it('backfills only source boards that still serve positive ranking rows', () => {
    expect(migration).toContain('FROM public.leaderboard_ranks AS ranks')
    expect(migration).toContain('WHERE ranks.arena_score > 0')
    expect(migration).toContain("source.status = 'active'")
    expect(migration).toContain("source.serving_mode = 'serving'")
    expect(migration).not.toContain("source.serving_mode <> 'legacy'")
    expect(migration).toContain("(source.meta->>'legacy_platform') IS DISTINCT FROM 'null'")
    expect(migration).toMatch(
      /COALESCE\(\s+NULLIF\(source\.meta->>'legacy_platform', ''\),\s+source\.slug\s+\)/
    )
    expect(migration).toContain('GROUP BY')
  })
})
