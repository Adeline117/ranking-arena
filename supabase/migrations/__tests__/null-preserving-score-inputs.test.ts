import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716123000_null_preserving_score_inputs.sql'),
  'utf8'
)

const boardBranch = migration.slice(
  migration.indexOf('-- Board rows remain present'),
  migration.indexOf('UNION ALL')
)
const firstPartyBranch = migration.slice(
  migration.indexOf('-- A claimed trader uses fresh first-party metrics'),
  migration.indexOf('GRANT SELECT ON arena.score_inputs')
)

describe('NULL-preserving score-input migration', () => {
  it('is bounded, atomic, and fails closed when its live foundations are absent', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
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
    expect(migration).toContain("to_regrole('service_role')")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('guards all three board metrics before applying their existing clamps', () => {
    expect(boardBranch).toMatch(
      /WHEN COALESCE\(e\.headline_roi, st\.roi\) IS NULL THEN NULL[\s\S]*ELSE LEAST\(GREATEST\(COALESCE\(e\.headline_roi, st\.roi\), -10000\), 10000\)[\s\S]*AS roi_pct/
    )
    expect(boardBranch).toMatch(
      /WHEN COALESCE\(e\.headline_win_rate, st\.win_rate\) IS NULL THEN NULL[\s\S]*ELSE LEAST\(GREATEST\(COALESCE\(e\.headline_win_rate, st\.win_rate\), 0\), 100\)[\s\S]*AS win_rate/
    )
    expect(boardBranch).toMatch(
      /WHEN st\.mdd IS NULL THEN NULL[\s\S]*ELSE LEAST\(abs\(st\.mdd\), 100\)[\s\S]*AS max_drawdown/
    )

    expect(boardBranch).not.toMatch(/^\s*LEAST\(GREATEST\(COALESCE\(e\.headline_(?:roi|win_rate)/m)
    expect(boardBranch).not.toMatch(/^\s*LEAST\(abs\(st\.mdd\), 100\)/m)
  })

  it('guards all three fresh first-party metrics without weakening anomaly bounds', () => {
    expect(firstPartyBranch).toMatch(
      /WHEN st\.roi IS NULL THEN NULL[\s\S]*ELSE LEAST\(GREATEST\(st\.roi, -10000\), 10000\)[\s\S]*AS roi_pct/
    )
    expect(firstPartyBranch).toMatch(
      /WHEN st\.win_rate IS NULL THEN NULL[\s\S]*ELSE LEAST\(GREATEST\(st\.win_rate, 0\), 100\)[\s\S]*AS win_rate/
    )
    expect(firstPartyBranch).toMatch(
      /WHEN st\.mdd IS NULL THEN NULL[\s\S]*ELSE LEAST\(abs\(st\.mdd\), 100\)[\s\S]*AS max_drawdown/
    )

    expect(migration.match(/WHEN st\.mdd IS NULL THEN NULL/g)).toHaveLength(2)
    expect(migration.match(/THEN NULL/g)).toHaveLength(6)
  })

  it('preserves latest-passed, serving, currency, and first-party precedence semantics', () => {
    expect(migration).toContain('WITH latest_passed AS')
    expect(migration).toContain('WHERE ls.count_check_passed')
    expect(migration).toContain('ORDER BY ls.source_id, ls.timeframe, ls.scraped_at DESC')
    expect(boardBranch).toContain("WHERE s.serving_mode <> 'legacy'")
    expect(boardBranch).toContain("s.currency = ANY (ARRAY['USDT','USDx','USDC','USD'])")
    expect(boardBranch).toContain("(s.meta->>'legacy_platform') IS DISTINCT FROM 'null'")
    expect(boardBranch).toContain('AND NOT EXISTS (')
    expect(migration).toContain("t.meta->>'claimed' = 'true'")
    expect(migration).toContain("st.extras->>'provenance' = 'first_party'")
    expect(migration).toContain("st.as_of > now() - interval '48 hours'")
    expect(migration.match(/UNION ALL/g)).toHaveLength(1)
  })

  it('keeps the complete score-input projection contract', () => {
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
  })

  it('postflights source/window cardinality and restores the serving contract', () => {
    expect(migration).toMatch(
      /CREATE TEMP TABLE score_input_counts_before[\s\S]*SELECT platform, "window", count\(\*\)::bigint AS row_count[\s\S]*GROUP BY platform, "window"/
    )
    expect(migration).toMatch(
      /WITH counts_after AS \([\s\S]*FULL JOIN counts_after after_count[\s\S]*before_count\.row_count IS DISTINCT FROM after_count\.row_count/
    )
    expect(migration).toContain(
      'NULL-preserving score-input migration changed source/window row counts'
    )
    expect(migration).toContain('GRANT SELECT ON arena.score_inputs TO service_role')
    expect(migration).toContain(
      "has_table_privilege('service_role', 'arena.score_inputs', 'SELECT')"
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
