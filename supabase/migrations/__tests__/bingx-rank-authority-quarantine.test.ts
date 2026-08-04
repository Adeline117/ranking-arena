import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260804051000_quarantine_bingx_rank_authority.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/bingx-rank-authority-quarantine.pg17.sh'),
  'utf8'
)
const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8')

describe('BingX public-rank authority quarantine', () => {
  it('is one lock-first read-committed transaction over the current rank authority', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL READ COMMITTED;')
    expect(migration).not.toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;')
    expect(migration).toContain("SET LOCAL lock_timeout = '15s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '3min'")

    for (const dependency of [
      "to_regclass('arena.sources')",
      "to_regclass('public.leaderboard_ranks')",
      "to_regclass('public.leaderboard_source_freshness')",
      "to_regclass('public.leaderboard_count_cache')",
      "'public.arena_freshness_expected_sources()'",
      "'public.rerank_public_eligible_leaderboard(text)'",
      "'public.refresh_public_rank_count_cache_for_seasons(text[])'",
      "'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamptz)'",
    ]) {
      expect(migration).toContain(dependency)
    }

    const mutableLocks = migration.indexOf(
      'LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE'
    )
    const lockedPreflight = migration.indexOf('DO $locked_preflight$')
    const affectedRead = migration.indexOf('INSERT INTO bingx_rank_affected_seasons')
    expect(mutableLocks).toBeGreaterThan(-1)
    expect(lockedPreflight).toBeGreaterThan(mutableLocks)
    expect(affectedRead).toBeGreaterThan(lockedPreflight)
    expect(migration).toContain(
      'READ COMMITTED deliberately takes this authoritative snapshot only after'
    )
  })

  it('binds both physical sources and every intended or fallback public alias', () => {
    for (const source of ['bingx_futures', 'bingx_spot']) {
      expect(migration).toContain(`source.slug = '${source}'`)
    }
    for (const dimension of [
      "exchange.slug = 'bingx'",
      "source.adapter_slug = 'bingx'",
      "source.trader_kind_scope = 'human'",
      'source.timeframes_native = ARRAY[7, 30, 90]::integer[]',
      'source.timeframes_derived = ARRAY[]::integer[]',
      "source.copier_table_depth = 'full'",
      "source.currency = 'USDT'",
      'source.page_size = 12',
      "source.pagination_kind = 'numeric'",
    ]) {
      expect(migration).toContain(dimension)
    }

    expect(migration).toContain("'bingx_futures', pg_catalog.to_jsonb(")
    expect(migration).toContain("ARRAY['bingx', 'bingx_futures']::pg_catalog.text[]")
    expect(migration).toContain("'bingx_spot', pg_catalog.to_jsonb(")
    expect(migration).toContain('source_alias_map jsonb NOT NULL')
    expect(migration).not.toMatch(/SET[\s\S]{0,80}legacy_platform/i)
  })

  it('archives exact full rows privately before removing only derived public surfaces', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS arena.bingx_rank_quarantine_batches')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS arena.bingx_rank_quarantine_rows')
    expect(migration).toContain('live_rank_id text NOT NULL')
    expect(migration).toContain('row_data jsonb NOT NULL')
    expect(migration).toContain('rank_row.id::text')
    expect(migration).toContain('pg_catalog.to_jsonb(rank_row)')
    expect(migration).toContain('v_archive_digest <> v_live_digest')
    expect(migration).toContain('v_deleted <> v_live_count')
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY')
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(/GRANT SELECT ON TABLE[\s\S]*TO service_role;/)

    for (const protectedRelation of [
      'leaderboard_snapshots',
      'leaderboard_entries',
      'traders',
      'trader_stats',
      'trader_series',
      'raw_captures',
      'trader_position_history',
    ]) {
      expect(migration).not.toContain(`DELETE FROM arena.${protectedRelation}`)
      expect(migration).not.toContain(`TRUNCATE arena.${protectedRelation}`)
    }
  })

  it('drains publishers, shadows sources, then uses the current canonical rerank and count RPCs', () => {
    const advisory = migration.indexOf("'arena.publish-board-series:' || v_source_id::text")
    const sourceLock = migration.indexOf('LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE')
    const rankLock = migration.indexOf(
      'LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE'
    )
    const archive = migration.indexOf('INSERT INTO arena.bingx_rank_quarantine_rows')
    const shadow = migration.indexOf("serving_mode = 'shadow'", archive)
    const rankDelete = migration.indexOf('DELETE FROM public.leaderboard_ranks AS rank_row')
    const rerank = migration.indexOf('public.rerank_public_eligible_leaderboard(v_season_id)')
    const refresh = migration.indexOf('public.refresh_public_rank_count_cache_for_seasons(', rerank)

    expect(advisory).toBeGreaterThan(-1)
    expect(sourceLock).toBeGreaterThan(advisory)
    expect(rankLock).toBeGreaterThan(sourceLock)
    expect(archive).toBeGreaterThan(rankLock)
    expect(shadow).toBeGreaterThan(archive)
    expect(rankDelete).toBeGreaterThan(shadow)
    expect(rerank).toBeGreaterThan(rankDelete)
    expect(refresh).toBeGreaterThan(rerank)

    expect(migration).not.toContain('SET rank = ordered.new_rank')
    expect(migration).toContain('bingx_rank_affected_seasons')
    expect(migration).toContain('BingX public rank surfaces contain a non-canonical season')
  })

  it('records all blockers while retaining active collection', () => {
    expect(migration).toMatch(
      /UPDATE arena\.sources AS source[\s\S]*serving_mode = 'shadow'[\s\S]*source\.status = 'active'[\s\S]*source\.serving_mode IN \('serving', 'shadow'\)/
    )
    expect(migration).not.toMatch(/SET\s+status\s*=/)
    expect(migration).toContain("'rank_visibility_contract', v_contract")
    expect(migration).toContain("'rank_visibility_reviewed_at', '2026-08-03'")
    for (const blocker of [
      'population_authority_unverified',
      'native_window_boundary_unverified',
      'record_history_completeness_unverified',
    ]) {
      expect(migration).toContain(blocker)
    }
  })

  it('rebuilds and validates all four durable guards on every replay', () => {
    for (const guard of [
      'sources_block_unverified_bingx_serving',
      'leaderboard_ranks_block_unverified_bingx',
      'leaderboard_freshness_block_unverified_bingx',
      'leaderboard_count_cache_block_unverified_bingx',
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `DROP CONSTRAINT IF EXISTS ${guard};[\\s\\S]*ADD CONSTRAINT ${guard}[\\s\\S]*NOT VALID;[\\s\\S]*VALIDATE CONSTRAINT ${guard};`
        )
      )
    }
    expect(migration).toContain("ARRAY['bingx_futures', 'bingx_spot']::pg_catalog.text[]")
    expect(migration).toContain("ARRAY['bingx', 'bingx_futures', 'bingx_spot']::pg_catalog.text[]")
    expect(migration).toContain('completed BingX quarantine replay found republished rank surfaces')
    expect(migration).toContain('v_guard_count <> 4')

    const dataPostflight = migration.indexOf('DO $data_postflight$')
    const firstGuardDdl = migration.indexOf(
      'DROP CONSTRAINT IF EXISTS sources_block_unverified_bingx_serving'
    )
    const lastGuardDdl = migration.indexOf(
      'VALIDATE CONSTRAINT leaderboard_count_cache_block_unverified_bingx'
    )
    const guardPostflight = migration.indexOf('DO $guard_postflight$')
    expect(dataPostflight).toBeGreaterThan(-1)
    expect(firstGuardDdl).toBeGreaterThan(dataPostflight)
    expect(lastGuardDdl).toBeGreaterThan(firstGuardDdl)
    expect(guardPostflight).toBeGreaterThan(lastGuardDdl)
  })

  it('postflights source state, canonical rank authority, archive reconstruction, and ACLs', () => {
    expect(migration).toContain('BingX source shadow postflight failed')
    expect(migration).toContain('BingX administrative rerank postflight failed')
    expect(migration).toContain("archive.row_data->>'id' IS DISTINCT FROM archive.live_rank_id")
    expect(migration).toContain('BingX rank archive postflight failed')
    expect(migration).toContain('BingX quarantine guard postflight failed')
    expect(migration).toContain('BingX private archive ACL postflight failed')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('has an isolated PostgreSQL 17 adversarial proof wired into package QA', () => {
    expect(pg17).toContain('PostgreSQL 17')
    expect(pg17).toContain('preservation_fingerprint')
    expect(pg17).toContain('assert_migration_fails')
    expect(pg17).toContain('constraint tamper')
    expect(pg17).toContain('delayed writer')
    expect(pg17).toContain('rollback')
    expect(packageJson).toContain('qa:bingx-rank-quarantine-pg17')
    expect(packageJson).toContain('bingx-rank-authority-quarantine.pg17.sh')
  })
})
