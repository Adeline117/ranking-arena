import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716124500_rank_only_active_serving_sources.sql'),
  'utf8'
)

const boardBranch = migration.slice(
  migration.indexOf('-- Only a source explicitly promoted'),
  migration.indexOf('UNION ALL')
)
const firstPartyBranch = migration.slice(
  migration.indexOf('-- Claimed first-party metrics obey'),
  migration.indexOf('GRANT SELECT ON arena.score_inputs')
)

describe('active-serving-only score-input migration', () => {
  it('is bounded, repeatable-read, atomic, and fails closed on lifecycle-schema drift', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")

    for (const relation of [
      'arena.score_inputs',
      'arena.sources',
      'arena.leaderboard_snapshots',
      'arena.leaderboard_entries',
      'arena.traders',
      'arena.trader_stats',
    ]) {
      expect(migration).toContain(`to_regclass('${relation}')`)
    }
    expect(migration).toContain("attribute.attname = 'status'")
    expect(migration).toContain("attribute.attname = 'serving_mode'")
    expect(migration).toContain("to_regrole('service_role')")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('requires active plus serving independently in the board branch', () => {
    expect(boardBranch).toMatch(/WHERE s\.serving_mode = 'serving'\s+AND s\.status = 'active'/)
    expect(boardBranch.match(/s\.serving_mode = 'serving'/g)).toHaveLength(1)
    expect(boardBranch.match(/s\.status = 'active'/g)).toHaveLength(1)
  })

  it('requires the identical active plus serving boundary in the first-party branch', () => {
    expect(firstPartyBranch).toMatch(/WHERE s\.serving_mode = 'serving'\s+AND s\.status = 'active'/)
    expect(firstPartyBranch.match(/s\.serving_mode = 'serving'/g)).toHaveLength(1)
    expect(firstPartyBranch.match(/s\.status = 'active'/g)).toHaveLength(1)
    expect(firstPartyBranch).toContain("t.meta->>'claimed' = 'true'")
    expect(firstPartyBranch).toContain("st.extras->>'provenance' = 'first_party'")
    expect(firstPartyBranch).toContain("st.as_of > now() - interval '48 hours'")
  })

  it('never treats every non-legacy source as ranking-eligible', () => {
    expect(migration.match(/s\.serving_mode = 'serving'/g)).toHaveLength(2)
    expect(migration.match(/s\.status = 'active'/g)).toHaveLength(2)
    expect(migration).not.toMatch(/serving_mode\s*<>\s*'legacy'/)
    expect(migration).not.toMatch(/serving_mode\s*!=\s*'legacy'/)
    expect(migration).not.toMatch(/serving_mode\s*=\s*'serving'\s+OR\s+s\.status\s*=\s*'active'/)
  })

  it('retains NULL preservation and anomaly clamps in both admitted branches', () => {
    expect(boardBranch).toMatch(
      /WHEN COALESCE\(e\.headline_roi, st\.roi\) IS NULL THEN NULL::numeric[\s\S]*ELSE LEAST\(GREATEST\(COALESCE\(e\.headline_roi, st\.roi\), -10000\), 10000\)/
    )
    expect(boardBranch).toMatch(
      /WHEN COALESCE\(e\.headline_win_rate, st\.win_rate\) IS NULL THEN NULL::numeric[\s\S]*ELSE LEAST\(GREATEST\(COALESCE\(e\.headline_win_rate, st\.win_rate\), 0\), 100\)/
    )
    expect(firstPartyBranch).toMatch(
      /WHEN st\.roi IS NULL THEN NULL::numeric[\s\S]*ELSE LEAST\(GREATEST\(st\.roi, -10000\), 10000\)/
    )
    expect(firstPartyBranch).toMatch(
      /WHEN st\.win_rate IS NULL THEN NULL::numeric[\s\S]*ELSE LEAST\(GREATEST\(st\.win_rate, 0\), 100\)/
    )
    expect(migration.match(/WHEN st\.mdd IS NULL THEN NULL::numeric/g)).toHaveLength(2)
    expect(migration.match(/THEN NULL::numeric/g)).toHaveLength(6)
  })

  it('keeps the exact 20-column view projection in both branches', () => {
    for (const projection of [
      'AS platform',
      'AS market_type',
      'AS trader_key',
      'AS "window"',
      'AS board_rank',
      'AS roi_pct',
      'AS pnl_usd',
      'AS win_rate',
      'AS max_drawdown',
      'AS copiers',
      'AS trades_count',
      'AS sharpe_ratio',
      'AS sortino_ratio',
      'AS calmar_ratio',
      'AS volatility_pct',
      't.trader_kind',
      'AS handle',
      'AS avatar_url',
      's.currency',
      'AS as_of',
    ]) {
      expect(boardBranch).toContain(projection)
      expect(firstPartyBranch).toContain(projection)
    }
    expect(migration.match(/UNION ALL/g)).toHaveLength(1)
  })

  it('preserves the view identity and lets both existing RPCs follow it dynamically', () => {
    expect(migration).toContain('CREATE OR REPLACE VIEW arena.score_inputs AS')
    expect(migration).not.toMatch(/DROP\s+VIEW/i)
    expect(migration).not.toMatch(/DROP\s+FUNCTION/i)
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.arena_score_inputs(?:_json)?\s*\(/
    )
    expect(migration).toContain('GRANT SELECT ON arena.score_inputs TO service_role')
  })

  it('allows cohort contraction, rejects growth, and reloads the serving schema', () => {
    expect(migration).toMatch(
      /CREATE TEMP TABLE score_input_total_before[\s\S]*SELECT count\(\*\)::bigint AS row_count[\s\S]*FROM arena\.score_inputs/
    )
    expect(migration).toContain('IF v_rows_after > v_rows_before THEN')
    expect(migration).toContain('serving isolation unexpectedly increased score-input rows')
    expect(migration).toContain(
      "has_table_privilege('service_role', 'arena.score_inputs', 'SELECT')"
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
