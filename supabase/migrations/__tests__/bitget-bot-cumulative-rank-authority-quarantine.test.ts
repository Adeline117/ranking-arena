import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const canonicalMigrationName = '20260728122000_bitget_bots_canonical_timeframe.sql'
const readerMigrationName = '20260728123000_arena_bot_header_canonical_snapshot.sql'
const migrationName = '20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql'
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

describe('Bitget bot cumulative public-rank authority quarantine', () => {
  it('runs after canonical capture/read convergence in one bounded transaction', () => {
    expect(Number(migrationName.slice(0, 14))).toBeGreaterThan(
      Number(canonicalMigrationName.slice(0, 14))
    )
    expect(Number(migrationName.slice(0, 14))).toBeGreaterThan(
      Number(readerMigrationName.slice(0, 14))
    )
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('pins the two exact canonical active serving Bitget bot identities', () => {
    expect(migration).toContain("'bitget_bots_futures'::text")
    expect(migration).toContain("'bitget_bots_spot'::text")
    expect(migration).toContain("exchange.slug = 'bitget'")
    expect(migration).toContain("source.adapter_slug = 'bitget_bots'")
    expect(migration).toContain("source.trader_kind_scope = 'bot'")
    expect(migration).toContain("source.status = 'active'")
    expect(migration).toContain("source.serving_mode = 'serving'")
    expect(migration).toContain('source.timeframes_native = ARRAY[30]::integer[]')
    expect(migration).toContain('source.timeframes_derived = ARRAY[]::integer[]')
    expect(migration).toContain('source.page_size = 20')
    expect(migration).toContain("source.pagination_kind = 'numeric'")
    expect(migration).toContain('["futures_grid", "futures_martingale"]')
    expect(migration).toContain('["spot_grid", "spot_martingale"]')
    expect(migration).toContain('v_exact_sources <> 2')
    expect(migration).toContain(
      'unexpected active Bitget bot source requires an explicit rank-authority review'
    )
    expect(migration).toMatch(
      /WHERE source\.status = 'active'\s+AND source\.adapter_slug = 'bitget_bots'\s+AND source\.slug <> ALL/
    )
  })

  it('quarantines score rows, publication evidence, and final rank authority together', () => {
    for (const signature of [
      'public.arena_score_inputs_json(text,integer,integer)',
      'public.arena_score_inputs_publish_bundle_json(text,integer,integer)',
      'public.arena_freshness_expected_sources()',
    ]) {
      expect(migration).toContain(`'${signature}'::text`)
    }

    expect(migration).toContain("'source'::text")
    expect(migration).toContain("'source_row'::text")
    expect(migration).toContain('3::integer')
    expect(migration).toContain('bitget-bot-cumulative-rank-quarantine@1')
    expect(migration).toContain('%1$s.slug = ANY (')
    expect(migration).toContain("OR %1$s.adapter_slug = 'bitget_bots'")
    expect(migration).toContain('v_needle_count <> v_target.expected_anchor_count')
    expect(migration).toContain('partial Bitget rank quarantine marker set')
    expect(migration).toContain('legacy_source_sha256')
    expect(migration).toContain('quarantined_source_sha256')
    expect(migration).toContain('Bitget rank authority body drifted')
    expect(migration).toContain('Bitget rank authority rewrite digest mismatch')
    expect(migration).toMatch(/[0-9a-f]{64}/)
    expect(migration).toContain('EXECUTE v_definition')
  })

  it('converges the reviewed legacy search path before preserving callable properties', () => {
    expect(migration).toContain("'search_path=public, arena, pg_temp'")
    expect(migration).toContain('accepts_legacy_search_path')
    expect(migration).toContain('ALTER FUNCTION public.arena_freshness_expected_sources()')
    expect(migration).toContain('SET search_path TO pg_catalog, pg_temp')
    expect(migration).toContain('bitget_bot_rank_function_contract_before')
    expect(migration).toContain("pg_catalog.to_jsonb(function_row) - 'prosrc'")
    expect(migration).toContain('pg_catalog.pg_get_functiondef(v_function)')
    expect(migration).toContain("pg_catalog.to_jsonb(v_after) - 'prosrc'")
    expect(migration).toContain('v_after.oid IS DISTINCT FROM v_contract.oid')
    expect(migration).toContain('rank-authority callable catalog contract changed')
    expect(migration).toContain("function_row.proowner = 'postgres'::pg_catalog.regrole")
    expect(migration).toContain('function_row.prosecdef')
    expect(migration).toContain("function_row.provolatile = 's'")
    expect(migration).toContain("ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]")
    expect(migration).toMatch(
      /pg_catalog\.has_function_privilege\(\s*'service_role', v_function, 'EXECUTE'\s*\)/
    )
    expect(migration).toContain("pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')")
    expect(migration).toMatch(
      /pg_catalog\.has_function_privilege\(\s*'authenticated', v_function, 'EXECUTE'\s*\)/
    )
  })

  it('atomically removes old rank visibility and repairs dependent rank state', () => {
    const registryLock = migration.indexOf(
      'LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE'
    )
    const rankLock = migration.indexOf(
      'LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE'
    )
    const rankDelete = migration.indexOf('DELETE FROM public.leaderboard_ranks AS rank_row')
    const freshnessDelete = migration.indexOf(
      'DELETE FROM public.leaderboard_source_freshness AS freshness'
    )
    const rerank = migration.indexOf('WITH rank_authority AS MATERIALIZED (')
    const cacheRefresh = migration.indexOf('SELECT public.refresh_leaderboard_count_cache();')

    expect(registryLock).toBeGreaterThan(-1)
    expect(registryLock).toBeLessThan(migration.indexOf('DO $preflight$'))
    expect(rankLock).toBeGreaterThan(registryLock)
    expect(rankDelete).toBeGreaterThan(rankLock)
    expect(freshnessDelete).toBeGreaterThan(rankDelete)
    expect(rerank).toBeGreaterThan(freshnessDelete)
    expect(cacheRefresh).toBeGreaterThan(rerank)
    expect(migration).toContain('bitget_bot_rank_affected_seasons')
    expect(migration).toContain('SET rank_change = NULL')
    expect(migration).toContain('rank_authority AS MATERIALIZED')
    expect(migration).toContain('classified AS MATERIALIZED')
    expect(migration).toContain('desired AS MATERIALIZED')
    expect(migration).toContain('arena.leaderboard_rank_row_is_public_eligible(')
    expect(migration).toContain('ORDER BY classified.arena_score DESC NULLS LAST, classified.id')
    expect(migration).toContain('SET rank = desired.expected_rank')
    expect(migration).toContain('rank-only quarantine changed Bitget bot serving visibility')

    expect(migration).not.toMatch(/UPDATE\s+arena\.sources/i)
    expect(migration).not.toMatch(/SET\s+serving_mode\s*=\s*'shadow'/i)
    expect(migration).not.toMatch(/DELETE FROM\s+arena\.(?:leaderboard|trader|bot)/i)
  })

  it('installs and validates a parent-table guard against stale writer reinsertion', () => {
    const constraint = 'leaderboard_ranks_block_cumulative_bitget_bot_authority'
    expect(migration).toContain(`DROP CONSTRAINT IF EXISTS\n    ${constraint}`)
    expect(migration).toContain(`ADD CONSTRAINT ${constraint}`)
    expect(migration).toContain(`VALIDATE CONSTRAINT ${constraint}`)
    expect(migration).toMatch(
      /CHECK \(\s*source <> ALL \(\s*ARRAY\[\s*'bitget_bots_futures',\s*'bitget_bots_spot'\s*\]::pg_catalog\.text\[\]/
    )
    expect(migration).toContain('constraint_row.convalidated')
    expect(migration).toContain('cumulative Bitget bot ranks remain publicly materialized')
    expect(migration).toContain('cumulative Bitget bot rank freshness remains published')
    expect(migration).toContain('cumulative Bitget bot leaderboard count cache remains published')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('moves every ranking substrate relation behind reviewed RPCs', () => {
    for (const relation of [
      'arena.bots',
      'arena.leaderboard_snapshots',
      'arena.leaderboard_entries',
      'arena.trader_stats',
      'arena.score_inputs',
    ]) {
      expect(migration).toContain(`REVOKE ALL PRIVILEGES ON TABLE ${relation}`)
      expect(migration).toContain(`GRANT SELECT ON TABLE ${relation} TO service_role`)
    }

    for (const policy of [
      'Public read bots',
      'Public read leaderboard_snapshots',
      'Public read leaderboard_entries',
      'Public read trader_stats',
    ]) {
      expect(migration).toContain(`DROP POLICY IF EXISTS "${policy}"`)
    }

    expect(migration).toContain('pg_catalog.pg_partition_tree(')
    expect(migration).toContain('entry_partition_acl_quarantine')
    expect(migration).toContain('ranking substrate retains a non-service relation privilege')
    expect(migration).toContain('ranking substrate retains a public RLS policy')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.arena_score_inputs\(text, integer, integer\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain('legacy table score-input RPC remains executable')
  })

  it('keeps profile reads honest while retaining explicit bot profile products', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.arena_core_modules(')
    expect(migration).toContain("'_arena_profile_publication_epoch_ms'")
    expect(migration).toContain('AS window_metrics_public')
    expect(migration).toContain('resolved.is_bitget_bot AND resolved.timeframe = 30')
    expect(migration).toContain('WHEN resolved.window_metrics_public THEN resolved.pnl')
    expect(migration).toContain("ELSE '{}'::pg_catalog.jsonb")
    expect(migration).toContain('pg_catalog.date_part(')
    expect(migration).toContain('bitget-bot-cumulative-public-reader-quarantine@1')
    expect(migration).toContain('caef116ff47e4b74bff0b8508717c2943f4a7a0beb5ba996d0793d46c18911fc')
    expect(migration).not.toMatch(/pg_catalog\.(?:least|greatest|extract)\s*\(/i)
  })

  it('scrubs historical duplicates and rejects every legacy board writer shape', () => {
    const entryScrub = migration.indexOf('UPDATE arena.leaderboard_entries AS entry')
    const statsScrub = migration.indexOf('UPDATE arena.trader_stats AS stats')
    const guardFunction = migration.indexOf(
      'CREATE OR REPLACE FUNCTION arena.guard_bitget_bot_leaderboard_entry()'
    )
    const guardTrigger = migration.indexOf('CREATE TRIGGER guard_bitget_bot_leaderboard_entry')

    expect(entryScrub).toBeGreaterThan(-1)
    expect(statsScrub).toBeGreaterThan(entryScrub)
    expect(guardFunction).toBeGreaterThan(statsScrub)
    expect(guardTrigger).toBeGreaterThan(guardFunction)
    expect(migration).toMatch(
      /SET headline_roi = NULL,\s*headline_pnl = NULL,\s*headline_win_rate = NULL,\s*raw = CASE/
    )
    expect(migration).toContain('bitget_bot_canonical_entry_raw_before')
    expect(migration).toContain('bitget_bot_entry_guard_before')
    expect(migration).toContain('Bitget bot entry guard replay contract drifted')
    expect(migration).toContain('stats.timeframe IN (7, 30, 90)')
    expect(migration).toContain('stats.timeframe IN (7, 90) AND stats.mdd IS NOT NULL')
    expect(migration).toContain("as_of = '1970-01-01 00:00:00+00'")
    expect(migration).toContain('NEW.timeframe <> 30')
    expect(migration).toContain('NEW.headline_roi IS NOT NULL')
    expect(migration).toContain('NEW.headline_pnl IS NOT NULL')
    expect(migration).toContain('NEW.headline_win_rate IS NOT NULL')
    expect(migration).toContain("'strategyId'")
    expect(migration).toContain("'strategyType'")
    expect(migration).toContain("'productId'")
    expect(migration).toContain("'strAccountId'")
    expect(migration).toContain('raw data must be the exact identity-only projection')
    expect(migration).toContain('mislabeled Bitget bot entry metrics or raw cards remain')
    expect(migration).toContain('mislabeled Bitget bot profile-window metrics remain warm')
    expect(migration).not.toMatch(/__[A-Z0-9_]+__/)
  })
})
