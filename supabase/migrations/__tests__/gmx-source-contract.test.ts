import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260715231500_fix_gmx_source_contract.sql'),
  'utf8'
)

describe('GMX source contract PREPARE migration', () => {
  it('is atomic, bounded, and takes the publisher plus writer locks', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("'arena.publish-board-series:' || id::text")
    expect(migration).toContain('LOCK TABLE arena.leaderboard_snapshots')
    expect(migration).toContain('LOCK TABLE public.leaderboard_ranks')
    expect(migration).toContain('SET LOCAL statement_timeout')
  })

  it('creates a private PREPARED/COMPLETE ledger and all reversible archives', () => {
    for (const table of [
      'data_contract_quarantine_batches',
      'source_registry_quarantine',
      'leaderboard_snapshots_quarantine',
      'trader_stats_quarantine',
      'trader_series_quarantine',
      'leaderboard_ranks_quarantine',
      'leaderboard_count_cache_quarantine',
    ]) {
      expect(migration).toContain(`arena.${table}`)
    }
    expect(migration).toContain("state IN ('PREPARED', 'COMPLETE')")
    expect(migration).toContain('archive_counts jsonb NOT NULL')
    expect(migration).toContain('archive_digests jsonb NOT NULL')
    expect(migration).toContain('FROM PUBLIC, anon, authenticated')
    expect(migration).toContain('TO service_role')
  })

  it('archives every affected serving, rank, and aggregate-cache surface', () => {
    expect(migration).toContain("series.metric = 'pnl'")
    expect(migration).toContain('rank_row.source = v_source_slug')
    for (const cacheKey of ['gmx', 'gmx_gt0', '_all', '_all_gt0']) {
      expect(migration).toContain(`'${cacheKey}'`)
    }
    expect(migration).toContain('to_jsonb(source_row)')
    expect(migration).toContain('to_jsonb(snapshot)')
    expect(migration).toContain('to_jsonb(stats)')
    expect(migration).toContain('to_jsonb(rank_row)')
    expect(migration).toContain('to_jsonb(cache_row)')
  })

  it('fails closed on orphan, changed, or digest-mismatched replays', () => {
    expect(migration).toContain('orphan/partial GMX archive')
    expect(migration).toContain('archive count/digest mismatch')
    expect(migration).toContain('live rows changed after PREPARE')
    expect(migration).toContain("v_batch.state NOT IN ('PREPARED', 'COMPLETE')")
    expect(migration).toContain('v_archive_counts <> v_live_counts')
    expect(migration).toContain('v_archive_digests <> v_live_digests')
  })

  it('does not change any serving or public materialized row', () => {
    expect(migration).not.toMatch(/UPDATE\s+arena\.sources/i)
    expect(migration).not.toMatch(/UPDATE\s+arena\.leaderboard_snapshots/i)
    expect(migration).not.toMatch(/UPDATE\s+arena\.trader_stats/i)
    expect(migration).not.toMatch(/DELETE\s+FROM\s+(arena|public)\./i)
    expect(migration).toContain("'PREPARED'")
  })
})
