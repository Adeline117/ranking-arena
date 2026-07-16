import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260715232500_quarantine_gmx_mixed_pnl.sql'),
  'utf8'
)

describe('GMX PnL contract CUTOVER migration', () => {
  it('is atomic, bounded, locked, and requires the PREPARED ledger', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('GMX CUTOVER requires PREPARE batch')
    expect(migration).toContain('FOR UPDATE')
    expect(migration).toContain("v_batch.state NOT IN ('PREPARED', 'COMPLETE')")
    expect(migration).toContain("'arena.publish-board-series:' || id::text")
    expect(migration).toContain('SET LOCAL statement_timeout')
  })

  it('verifies immutable archive and live digests before mutation', () => {
    expect(migration).toContain('v_batch.archive_counts <> v_archive_counts')
    expect(migration).toContain('v_batch.archive_digests <> v_archive_digests')
    expect(migration).toContain('v_live_counts <> v_archive_counts')
    expect(migration).toContain('v_live_digests <> v_archive_digests')
    expect(migration).toContain('live rows changed after PREPARE')
  })

  it('mutates snapshots, stats, series, ranks, and cache only by archived keys', () => {
    expect(migration).toContain('snapshot.id = archive.snapshot_id')
    expect(migration).toContain('stats.trader_id = archive.trader_id')
    expect(migration).toContain('stats.timeframe = archive.timeframe')
    expect(migration).toContain('series.ts = archive.point_at')
    expect(migration).toContain("series.week_start = (archive.point_at AT TIME ZONE 'UTC')::date")
    expect(migration).toContain('rank_row.id = archive.rank_id')
    expect(migration).toContain('rank_row.season_id = archive.season_id')
    expect(migration).toContain('cache_row.season_id = archive.season_id')
    expect(migration).toContain('cache_row.source = archive.cache_source')
  })

  it('clears every old window metric and misleading provenance key', () => {
    for (const column of [
      'roi',
      'pnl',
      'sharpe',
      'mdd',
      'win_rate',
      'win_positions',
      'total_positions',
      'aum',
      'volume',
      'holding_duration_avg',
    ]) {
      expect(migration).toContain(`${column} = NULL`)
    }
    for (const key of [
      'pnl_basis',
      'roi_basis',
      'profile_series_contract',
      'window_from',
      'window_to',
      'window_duration_days',
      'risk_derivation',
      'sortino',
    ]) {
      expect(migration).toContain(`'${key}'`)
    }
    expect(migration).toContain("'gmx_pnl_contract_quarantined', true")
    expect(migration).not.toContain("'gmx_pnl_contract_version', 2")
  })

  it('invalidates old materializations, rebuilds global counts, then publishes source v2', () => {
    const rankDelete = migration.indexOf('DELETE FROM public.leaderboard_ranks')
    const cacheDelete = migration.indexOf('DELETE FROM public.leaderboard_count_cache')
    const refresh = migration.indexOf('PERFORM public.refresh_leaderboard_count_cache()')
    const sourceUpdate = migration.indexOf('UPDATE arena.sources AS source_row')
    expect(rankDelete).toBeGreaterThan(-1)
    expect(cacheDelete).toBeGreaterThan(rankDelete)
    expect(refresh).toBeGreaterThan(cacheDelete)
    expect(sourceUpdate).toBeGreaterThan(refresh)
    expect(migration).toContain('https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql')
    expect(migration).toContain("'pnl_basis_board', 'gmx_period_realized_net'")
    expect(migration).toContain("'roi_basis_board', 'max_capital_usd'")
    expect(migration).toContain("'pnl_contract_version', 2")
    expect(migration).toContain("'window_semantics', 'completed_utc_days'")
  })

  it('uses null-safe final assertions and records COMPLETE only after they pass', () => {
    expect(migration).toContain('IS NOT DISTINCT FROM')
    expect(migration).toContain('GMX passed snapshots remain after CUTOVER')
    expect(migration).toContain('GMX mixed-window stats remain after CUTOVER')
    expect(migration).toContain('GMX generic PnL series remain after CUTOVER')
    expect(migration).toContain('GMX public ranks remain after CUTOVER')
    expect(migration).toContain('GMX direct count-cache rows remain after CUTOVER')
    expect(migration).toContain('global leaderboard count cache does not match live ranks')
    expect(migration).toContain("SET state = 'COMPLETE'")
    expect(migration).toContain('cutover_counts = v_cutover_counts')
  })
})
