import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260721180903_metric_rankable_score_inputs_shadow.sql'),
  'utf8'
)

const view = migration.slice(
  migration.indexOf('CREATE OR REPLACE VIEW arena.metric_rankable_score_inputs_shadow'),
  migration.indexOf(
    'CREATE OR REPLACE FUNCTION public.arena_metric_rankable_score_inputs_shadow_json'
  )
)
const rpc = migration.slice(
  migration.indexOf(
    'CREATE OR REPLACE FUNCTION public.arena_metric_rankable_score_inputs_shadow_json'
  ),
  migration.indexOf('REVOKE ALL ON arena.metric_rankable_score_inputs_shadow')
)

describe('metric-rankable score-input shadow migration', () => {
  it('is an atomic canary and leaves every live score surface unchanged', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).not.toMatch(/CREATE OR REPLACE VIEW arena\.score_inputs\b/)
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.arena_score_inputs_json/)
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b[\s\S]*leaderboard_ranks/i)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('selects the latest persisted attempt before requiring a PASSED board', () => {
    expect(view).toContain('WITH latest_attempt AS MATERIALIZED')
    expect(view).toContain('SELECT DISTINCT ON (snapshot.source_id, snapshot.timeframe)')
    expect(view).toMatch(
      /ORDER BY\s+snapshot\.source_id,\s+snapshot\.timeframe,\s+snapshot\.scraped_at DESC,\s+snapshot\.id DESC/
    )
    expect(view).not.toMatch(
      /FROM arena\.leaderboard_snapshots[\s\S]*?WHERE snapshot\.count_check_passed[\s\S]*?ORDER BY/
    )
    expect(view.indexOf('WITH latest_attempt AS MATERIALIZED')).toBeLessThan(
      view.indexOf('JOIN arena.metric_rankable_input_sets_shadow AS pair')
    )
    expect(view).toContain('WHERE latest.count_check_passed')
    expect(view).toContain('pair.snapshot_id = latest.snapshot_id')
    expect(view).not.toMatch(/DISTINCT ON \([^)]*pair/i)
  })

  it('rejects future clocks and incomplete physical board publication', () => {
    expect(view).toContain(
      "latest.scraped_at <= pg_catalog.statement_timestamp() + interval '5 minutes'"
    )
    expect(view).toContain(
      "run.completed_at <= pg_catalog.statement_timestamp() + interval '5 minutes'"
    )
    expect(view).toContain('current_entry_counts AS MATERIALIZED')
    expect(view).toContain('entry_count.entry_count = latest.actual_count::bigint')
    expect(view).toContain('entry_count.compatible_entry_count = latest.actual_count::bigint')
    expect(view).toContain("entry.currency = 'USDT'")
    expect(view).toContain('entry_trader.source_id = latest.source_id')
  })

  it('binds the pair to the exact run, entry, source, timeframe, units, and USDT method', () => {
    for (const token of [
      'run.source_run_id = pair.source_run_id',
      'run.snapshot_id = latest.snapshot_id',
      'run.snapshot_scraped_at = latest.scraped_at',
      'roi_evidence.id = pair.roi_observation_id',
      "roi_evidence.value_unit = 'percent'",
      'pnl_evidence.id = pair.pnl_observation_id',
      "pnl_evidence.value_unit = 'currency'",
      'trader.source_id = latest.source_id',
      'entry.snapshot_id = latest.snapshot_id',
      'entry.trader_id = pair.trader_id',
      'entry.scraped_at = latest.scraped_at',
      'entry.timeframe = latest.timeframe',
      "pair.currency = 'USDT'",
      "source.currency = 'USDT'",
      "entry.currency = 'USDT'",
      'pair.rank_eligible',
    ]) {
      expect(view).toContain(token)
    }
    expect(view).toContain("source.status = 'active'")
    expect(view).toContain("source.serving_mode = 'serving'")
    expect(view).toContain('pair.timeframe = ANY')
    expect(view).toContain('source.timeframes_native')
    expect(view).toContain('source.timeframes_derived')
    expect(view).toContain("'arena-core-roi-pnl-30d-usdt@1'")
    expect(view).toContain("'USDT'::pg_catalog.text AS comparison_currency")
  })

  it('projects only trusted ROI/PnL and nulls every unregistered score metric', () => {
    expect(view).toContain('pair.roi AS roi_pct')
    expect(view).toContain('pair.pnl AS pnl_usd')
    for (const field of [
      'win_rate',
      'max_drawdown',
      'copiers',
      'trades_count',
      'sharpe_ratio',
      'sortino_ratio',
      'calmar_ratio',
      'volatility_pct',
    ]) {
      expect(view).toContain(`NULL::pg_catalog.numeric AS ${field}`)
    }
    expect(view).not.toMatch(/trader_stats|COALESCE\([^)]*(?:roi|pnl|win_rate|mdd|sharpe)/i)
  })

  it('rejects invalid canary arguments instead of conflating them with an empty cohort', () => {
    expect(rpc).toMatch(
      /LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
    )
    expect(rpc).toContain("p_window NOT IN ('7D', '30D', '90D')")
    expect(rpc).toContain('p_per_platform_limit > 10000')
    expect(rpc).toContain('p_max_age_hours > 168')
    expect(rpc.match(/USING ERRCODE = '22023'/g)).toHaveLength(3)
  })

  it('returns score rows with a registry-complete cohort authority envelope', () => {
    expect(rpc).toContain('registry_cohorts AS MATERIALIZED')
    expect(rpc).toContain('any_pair_contract_coverage AS MATERIALIZED')
    expect(rpc).toContain('method_contract_coverage AS MATERIALIZED')
    expect(rpc).toContain('latest_attempt AS MATERIALIZED')
    expect(rpc).toContain('FROM arena.metric_rankable_score_inputs_shadow AS score_input')
    for (const state of [
      'comparison_currency_mismatch',
      'ranking_contract_missing',
      'ranking_contract_currency_mismatch',
      'snapshot_missing',
      'snapshot_future',
      'snapshot_stale',
      'snapshot_partial',
      'population_count_mismatch',
      'trust_run_missing',
      'trust_run_future',
      'acquisition_partial',
      'acquisition_unknown',
      'population_partial',
      'population_unknown',
      'verified_empty',
      'metrics_unrankable',
      'rankable',
    ]) {
      expect(rpc).toContain(`'${state}'`)
    }
    for (const field of [
      'schemaVersion',
      'authorityScope',
      'enforcementMode',
      'actionsAdvisory',
      'window',
      'rankDepth',
      'rankingMethodId',
      'comparisonCurrency',
      'scoreRows',
      'cohorts',
      'latest_attempt_id',
      'latest_attempt_scraped_at',
      'latest_attempt_passed',
      'source_run_id',
      'acquisition_state',
      'population_state',
      'fetched_population',
      'eligible_count',
      'returned_count',
      'rank_depth',
      'compatible_entry_count',
      'source_contract_versions',
      'metric_set_ids',
      'contract_currencies',
      'evidence_state',
      'reason',
      'rows_authoritative',
      'withdrawal_allowed',
      'action_advisory',
      'publication_action',
    ]) {
      expect(rpc).toContain(`'${field}'`)
    }
    expect(rpc).toContain('JOIN cohort_evidence AS cohort')
    expect(rpc).toContain('cohort.rows_authoritative')
  })

  it('keeps the view and bundle service-only', () => {
    expect(migration).toMatch(
      /REVOKE ALL\s+ON FUNCTION public\.arena_metric_rankable_score_inputs_shadow_json\(text, int, int\)\s+FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.arena_metric_rankable_score_inputs_shadow_json\(text, int, int\)\s+TO service_role;/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON arena\.metric_rankable_score_inputs_shadow\s+FROM PUBLIC, anon, authenticated;/
    )
  })
})
