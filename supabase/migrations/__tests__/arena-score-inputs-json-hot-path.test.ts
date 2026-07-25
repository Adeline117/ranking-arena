import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260724234000_optimize_arena_score_inputs_json_hot_path.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/expire-stale-score-fallbacks.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

const functionBody = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.arena_score_inputs_json'),
  migration.indexOf('$function$;', migration.indexOf('CREATE OR REPLACE FUNCTION'))
)
const regularBranch = functionBody.slice(
  functionBody.indexOf('score_rows AS ('),
  functionBody.indexOf('UNION ALL', functionBody.indexOf('score_rows AS ('))
)
const firstPartyBranch = functionBody.slice(
  functionBody.indexOf('UNION ALL', functionBody.indexOf('score_rows AS (')),
  functionBody.indexOf('SELECT COALESCE(', functionBody.indexOf('UNION ALL'))
)

describe('arena score-input JSON hot-path migration', () => {
  it('forward-replaces only the existing JSON RPC and preserves its callable contract', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.arena_score_inputs_json\(\s*p_window text,\s*p_per_platform_limit int DEFAULT 1000,\s*p_max_age_hours int DEFAULT 48\s*\)\s*RETURNS jsonb/
    )
    expect(migration).toMatch(
      /LANGUAGE sql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).not.toMatch(/CREATE OR REPLACE VIEW/i)
    expect(migration).not.toMatch(/DROP\s+(?:FUNCTION|VIEW|TABLE)/i)
    expect(migration).not.toMatch(/statement_timeout\s*=\s*'30s'/i)
    expect(functionBody).not.toMatch(/entry\.rank\s*<=\s*[1-9]\d*/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('uses the requested numeric timeframe and never expands arena.score_inputs', () => {
    for (const mapping of [
      "WHEN '7D' THEN 7::pg_catalog.int2",
      "WHEN '30D' THEN 30::pg_catalog.int2",
      "WHEN '90D' THEN 90::pg_catalog.int2",
    ]) {
      expect(functionBody).toContain(mapping)
    }
    expect(functionBody).toContain('snapshot.timeframe = requested.timeframe')
    expect(functionBody).not.toContain('FROM arena.score_inputs')
    expect(functionBody).not.toContain('JOIN arena.score_inputs')
    expect(migration).toContain('arena_score_inputs_json still depends on arena.score_inputs')
  })

  it('binds both entry identity columns and pushes rank and freshness gates down', () => {
    expect(
      functionBody.match(
        /entry\.snapshot_id = latest\.snapshot_id\s+AND entry\.scraped_at = latest\.scraped_at/g
      )
    ).toHaveLength(2)
    expect(regularBranch).toContain('entry.rank <= p_per_platform_limit')
    expect(regularBranch).toContain('latest.scraped_at > requested.requested_cutoff')
    expect(firstPartyBranch).toContain('board_rank.rank <= p_per_platform_limit')
    expect(firstPartyBranch).toContain('stats.as_of > requested.requested_cutoff')
    expect(migration).toContain(
      'latest served leaderboard entry scraped_at disagrees with its snapshot'
    )
  })

  it('retains fallback, first-party, alias watermark, and full payload semantics', () => {
    expect(functionBody).toContain('fresh_first_party AS MATERIALIZED')
    expect(regularBranch).toContain('NOT EXISTS (')
    expect(firstPartyBranch).toContain("stats.extras->>'provenance' = 'first_party'")
    expect(firstPartyBranch).not.toContain("legacy_platform') IS DISTINCT FROM 'null'")
    expect(functionBody).toContain('pg_catalog.min(latest.scraped_at) AS board_as_of')
    expect(functionBody).toContain("NULLIF(source.meta->>'legacy_platform', '')")
    for (const field of [
      'platform',
      'market_type',
      'trader_key',
      'board_rank',
      'roi_pct',
      'pnl_usd',
      'win_rate',
      'max_drawdown',
      'copiers',
      'trades_count',
      'sharpe_ratio',
      'sortino_ratio',
      'calmar_ratio',
      'volatility_pct',
      'trader_kind',
      'handle',
      'avatar_url',
      'currency',
      'as_of',
      'board_as_of',
    ]) {
      expect(functionBody).toContain(field)
    }
  })

  it('preserves identity, defaults, owner, ACL and the service-only boundary', () => {
    for (const catalogField of [
      'oid',
      'proowner',
      'proacl',
      'prorettype',
      'pronargdefaults',
      'proargdefaults',
      'prosecdef',
      'proconfig',
      'provolatile',
    ]) {
      expect(migration).toContain(`function_row.${catalogField}`)
    }
    expect(migration).toMatch(
      /REVOKE ALL\s+ON FUNCTION public\.arena_score_inputs_json\(text, int, int\)\s+FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.arena_score_inputs_json\(text, int, int\)\s+TO service_role;/
    )
  })

  it('ships executable PG17 multiset, invariant, pruning, and cardinality proofs', () => {
    expect(pg17).toContain(`HOT_PATH_MIGRATION="$ROOT_DIR/supabase/migrations/${migrationName}"`)
    expect(pg17.match(/EXCEPT ALL/g)?.length).toBeGreaterThanOrEqual(4)
    expect(pg17).toContain('hot-path migration accepted a mismatched entry partition key')
    expect(pg17).toContain('leaderboard_entries_2025_[0-9]+.*\\(never executed\\)')
    expect(pg17).toContain('runtime-pruning it')
    expect(pg17).toContain("SET statement_timeout = '10s'")
    expect(pg17).toContain('assert_equal "$requested_window high-cardinality payload count"')
    expect(pg17).toContain("'30000'")
  })

  it('is ordered after partial pipeline-log success and outside frozen recovery', () => {
    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    )
    const recovery = runner.slice(
      runner.indexOf('RECOVERY_PREREQUISITE_MIGRATIONS=('),
      runner.indexOf('CONCURRENT_RECOVERY_MIGRATIONS=(')
    )
    expect(predeploy).toContain(migrationName)
    expect(
      predeploy.indexOf('20260724232500_allow_pipeline_logs_partial_success.sql')
    ).toBeLessThan(predeploy.indexOf(migrationName))
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(1)
    expect(recovery).not.toContain(migrationName)
  })
})
