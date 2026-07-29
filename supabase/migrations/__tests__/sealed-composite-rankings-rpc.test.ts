import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729071757_sealed_composite_rankings_rpc.sql'),
  'utf8'
)
const runner = readFileSync(
  join(process.cwd(), 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)

describe('sealed composite rankings RPC', () => {
  it('is registered as an ordered predeploy migration', () => {
    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    )
    expect(predeploy).toContain('20260729071757_sealed_composite_rankings_rpc.sql')
    expect(predeploy.indexOf('20260729071000_atomic_primary_trader_projection.sql')).toBeLessThan(
      predeploy.indexOf('20260729071757_sealed_composite_rankings_rpc.sql')
    )
  })

  it('binds all three seasons to caller-proved publication cohorts and authorities', () => {
    expect(migration).toContain("ranks.season_id = '7D'")
    expect(migration).toContain('ranks.rank_publication_id = p_7d_cohort_id')
    expect(migration).toContain('ranks.source = ANY (p_7d_sources)')
    expect(migration).toContain("ranks.season_id = '30D'")
    expect(migration).toContain('ranks.rank_publication_id = p_30d_cohort_id')
    expect(migration).toContain('ranks.source = ANY (p_30d_sources)')
    expect(migration).toContain("ranks.season_id = '90D'")
    expect(migration).toContain('ranks.rank_publication_id = p_90d_cohort_id')
    expect(migration).toContain('ranks.source = ANY (p_90d_sources)')
    expect(migration).toContain('arena.leaderboard_rank_publications')
    expect(migration).toContain('v_receipt_sources <> p_7d_sources')
    expect(migration).toContain('v_receipt_sources <> p_30d_sources')
    expect(migration).toContain('v_receipt_sources <> p_90d_sources')
  })

  it('computes the documented 5/25/70 score instead of relabeling a 90D row', () => {
    expect(migration).toContain('score_7d * 0.05')
    expect(migration).toContain('score_30d * 0.25')
    expect(migration).toContain('score_90d * 0.70')
    expect(migration).toContain("'composite_score', page.composite_score")
    expect(migration).toContain("'score_7d', page.score_7d")
    expect(migration).toContain("'score_30d', page.score_30d")
    expect(migration).toContain("'score_90d', page.score_90d")
  })

  it('is server-only and executes with a fixed safe search path', () => {
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.arena_read_composite_rankings_v1\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.arena_read_composite_rankings_v1\([\s\S]*?\) TO service_role;/
    )
  })
})
