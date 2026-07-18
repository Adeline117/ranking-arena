import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260718123000_shadow_sources_without_roi_basis.sql'),
  'utf8'
)
const sourceLoader = readFileSync(join(process.cwd(), 'lib/ingest/sources.ts'), 'utf8')
const visibleSourcesRpc = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716071500_visible_leaderboard_sources.sql'),
  'utf8'
)
const coverageAudit = readFileSync(
  join(process.cwd(), 'scripts/qa/pipeline-coverage-audit.mjs'),
  'utf8'
)

describe('ROI-less ranking source shadow migration', () => {
  it('is atomic, bounded, and fails closed on schema or lifecycle drift', () => {
    expect(migration).toContain('BEGIN;')
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)

    for (const relation of [
      'arena.sources',
      'arena.leaderboard_snapshots',
      'arena.leaderboard_entries',
      'arena.traders',
      'arena.trader_stats',
      'public.leaderboard_ranks',
    ]) {
      expect(migration).toContain(`to_regclass('${relation}')`)
    }
    expect(migration).toContain('v_source_count <> 2 OR v_active_serving_count <> 2')
    expect(migration).toContain('GET DIAGNOSTICS v_updated = ROW_COUNT')
    expect(migration).toContain('v_updated <> 2')
  })

  it('refuses to hide a source if latest PASSED data gains real ROI or public ranks', () => {
    expect(migration).toContain('DISTINCT ON (snapshot.source_id, snapshot.timeframe)')
    expect(migration).toContain('snapshot.count_check_passed')
    expect(migration).toContain('COALESCE(entry.headline_roi, stats.roi) IS NOT NULL')
    expect(migration).toContain('IF v_real_roi_rows <> 0 THEN')

    expect(migration).toContain("rank_row.source IN ('gtrade', 'bitfinex')")
    expect(migration).toContain('rank_row.arena_score > 0')
    expect(migration).toContain('rank_row.is_outlier IS NOT TRUE')
    expect(migration).not.toMatch(/rank_row\.roi\s+BETWEEN/)
    expect(migration).toContain('IF v_visible_rank_rows <> 0 THEN')
  })

  it('shadows only the ranking/read path while preserving active ingestion', () => {
    expect(migration).toMatch(
      /UPDATE arena\.sources AS source[\s\S]*serving_mode = 'shadow'[\s\S]*source\.slug IN \('gtrade', 'bitfinex'\)[\s\S]*source\.status = 'active'[\s\S]*source\.serving_mode = 'serving'/
    )
    expect(migration).not.toMatch(/SET\s+status\s*=/)
    expect(migration).toContain("'rank_visibility_blocker', 'missing_real_roi_basis'")
    expect(migration).toContain("'rank_visibility_reviewed_at', '2026-07-18'")

    // The scheduler selects status='active', independently of serving_mode,
    // so PASSED snapshot/profile collection continues after the downgrade.
    expect(sourceLoader).toContain("FROM arena.sources WHERE status = 'active' ORDER BY slug")
  })

  it('uses the existing serving-mode control surface for product coverage and QA', () => {
    expect(sourceLoader).toContain("WHERE serving_mode = 'serving'")
    expect(visibleSourcesRpc).toContain("source_row.serving_mode = 'serving'")
    expect(visibleSourcesRpc).toContain('count_row.total_count > 0')
    expect(coverageAudit).toContain("r.serving_mode === 'serving' && apiRows === 0")
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
