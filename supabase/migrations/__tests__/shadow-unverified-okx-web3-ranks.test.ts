import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260724010000_shadow_unverified_okx_web3_ranks.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(
  join(process.cwd(), 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)

describe('unverified OKX Web3 public-rank quarantine', () => {
  it('is one bounded atomic PREDEPLOY and stays independent of metric-trust backlog', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).not.toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '15s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '3min'")

    for (const required of [
      "to_regclass('arena.sources')",
      "to_regclass('public.leaderboard_ranks')",
      "to_regclass('public.leaderboard_count_cache')",
      "to_regprocedure('public.refresh_leaderboard_count_cache()')",
      "to_regrole('anon')",
      "to_regrole('authenticated')",
      "to_regrole('service_role')",
    ]) {
      expect(migration).toContain(required)
    }

    for (const forbiddenDependency of [
      'metric_source_contracts',
      'metric_trust_runs',
      'metric_trust_observations',
      'leaderboard_acquisition_attempts',
    ]) {
      expect(migration).not.toContain(forbiddenDependency)
    }
  })

  it('uses source-specific private archives with full rows and type-stable rank identity', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS arena.okx_web3_rank_quarantine_batches')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS arena.okx_web3_rank_quarantine_rows')
    expect(migration).toContain('live_rank_id text NOT NULL')
    expect(migration).toContain('row_data jsonb NOT NULL')
    expect(migration).toContain('rank_row.id::text')
    expect(migration).toContain('pg_catalog.to_jsonb(rank_row)')
    expect(migration).toContain('PRIMARY KEY (batch_id, season_id, source_trader_id)')

    expect(migration).toContain('ENABLE ROW LEVEL SECURITY')
    expect(migration).toMatch(/REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated;/)
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE[\s\S]*TO service_role;/
    )
  })

  it('fences publishers before archiving, validates a stable digest, then removes only derived ranks', () => {
    const advisory = migration.indexOf("'arena.publish-board-series:' || source.id::text")
    const sourceLock = migration.indexOf('LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE')
    const rankLock = migration.indexOf(
      'LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE'
    )
    const archive = migration.indexOf('INSERT INTO arena.okx_web3_rank_quarantine_rows')
    const sourceShadow = migration.indexOf("serving_mode = 'shadow'")
    const rankDelete = migration.indexOf('DELETE FROM public.leaderboard_ranks AS rank_row')
    const cacheRefresh = migration.indexOf('PERFORM public.refresh_leaderboard_count_cache()')

    expect(advisory).toBeGreaterThan(-1)
    expect(sourceLock).toBeGreaterThan(advisory)
    expect(rankLock).toBeGreaterThan(sourceLock)
    expect(archive).toBeGreaterThan(rankLock)
    expect(sourceShadow).toBeGreaterThan(archive)
    expect(rankDelete).toBeGreaterThan(sourceShadow)
    expect(cacheRefresh).toBeGreaterThan(rankDelete)

    expect(migration.match(/pg_catalog\.md5\(/g)).toHaveLength(3)
    expect(migration).toContain('v_archive_digest <> v_live_digest')
    expect(migration).toContain('v_deleted::bigint <> v_live_count')
    expect(migration.match(/DELETE FROM /g)).toHaveLength(1)
    expect(migration).not.toMatch(
      /DELETE FROM arena\.(?:leaderboard_snapshots|leaderboard_entries|traders|trader_stats|trader_series|raw)/
    )
  })

  it('keeps ingestion active while recording every current ranking blocker', () => {
    expect(migration).toMatch(
      /UPDATE arena\.sources AS source[\s\S]*serving_mode = 'shadow'[\s\S]*source\.status = 'active'[\s\S]*source\.serving_mode = 'serving'/
    )
    expect(migration).not.toMatch(/SET\s+status\s*=/)

    for (const blocker of [
      'pagination_snapshot_unavailable',
      'native_window_boundary_unverified',
      'ranking_method_currency_mismatch',
      'source_currency_label_mismatch',
    ]) {
      expect(migration).toContain(blocker)
    }
    expect(migration).toContain("'rank_visibility_contract', 'okx-web3-ranking-quarantine@1'")
    expect(migration).toContain("'rank_visibility_reviewed_at', '2026-07-24'")
  })

  it('installs validated source and rank guards against stale or accidental republishing', () => {
    expect(migration).toMatch(
      /ADD CONSTRAINT sources_block_unverified_okx_web3_solana_serving[\s\S]*slug <> 'okx_web3_solana'[\s\S]*serving_mode <> 'serving'/
    )
    expect(migration).toMatch(
      /ADD CONSTRAINT leaderboard_ranks_block_unverified_okx_web3_solana[\s\S]*CHECK \(source <> 'okx_web3_solana'\)/
    )
    expect(migration).toContain('constraint_row.convalidated')
    expect(migration).toContain(
      'completed OKX quarantine replay found newly published public ranks'
    )
  })

  it('postflights shadow state, zero public/cache rows, archive identity, and both guards', () => {
    expect(migration).toContain("source.meta->>'rank_visibility' = 'shadow'")
    expect(migration).toContain("source.meta->'rank_visibility_blockers'")
    expect(migration).toContain("cache_row.source IN (v_source_slug, v_source_slug || '_gt0')")
    expect(migration).toContain('v_archive_count <> v_batch.archived_rank_count')
    expect(migration).toContain('IF v_guard_count <> 2 THEN')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('is the final ordered PREDEPLOY but never expands the frozen recovery snapshot', () => {
    const predeployStart = runner.indexOf('PREDEPLOY_MIGRATIONS=(')
    const quarantineStart = runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    const predeploy = runner.slice(predeployStart, quarantineStart)
    const recoveryStart = runner.indexOf('RECOVERY_PREREQUISITE_MIGRATIONS=(')
    const recoveryEnd = runner.indexOf('CONCURRENT_RECOVERY_MIGRATIONS=(')
    const recovery = runner.slice(recoveryStart, recoveryEnd)

    expect(predeploy).toContain(migrationName)
    expect(predeploy.indexOf(migrationName)).toBeGreaterThan(
      predeploy.indexOf('20260722055000_metric_trust_source_page_lineage_forward_repair.sql')
    )
    expect(recovery).not.toContain(migrationName)
  })
})
