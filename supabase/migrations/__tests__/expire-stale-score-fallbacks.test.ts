import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716135000_expire_stale_score_fallbacks.sql'),
  'utf8'
)
const boardBranchStart = migration.indexOf('-- Board membership and headline values')
const viewDefinition = migration.slice(
  migration.indexOf('CREATE OR REPLACE VIEW arena.score_inputs AS'),
  migration.indexOf('GRANT SELECT ON arena.score_inputs')
)
const boardBranch = migration.slice(
  boardBranchStart,
  migration.indexOf('UNION ALL', boardBranchStart)
)
const firstPartyBranch = migration.slice(
  migration.indexOf('-- Claimed first-party metrics'),
  migration.indexOf('GRANT SELECT ON arena.score_inputs')
)

describe('stale score fallback expiry migration', () => {
  it('is atomic, bounded, and fails closed on missing foundations', () => {
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
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('keeps latest board headlines but only joins stats proven within 48 hours', () => {
    expect(migration).toContain('WHERE ls.count_check_passed')
    expect(migration).toContain('ORDER BY ls.source_id, ls.timeframe, ls.scraped_at DESC')
    expect(boardBranch).toMatch(
      /LEFT JOIN arena\.trader_stats st[\s\S]*st\.trader_id = t\.id[\s\S]*st\.timeframe = lp\.timeframe[\s\S]*st\.as_of > now\(\) - interval '48 hours'/
    )
    expect(migration).toContain('an observation at exactly 48h is expired')
    expect(migration).toContain('conservative row-level')
    expect(boardBranch).toContain('COALESCE(e.headline_roi, st.roi)')
    expect(boardBranch).toContain('COALESCE(e.headline_pnl, st.pnl)')
    expect(boardBranch).toContain('COALESCE(e.headline_win_rate, st.win_rate)')
    for (const fallback of [
      'st.mdd',
      'st.copier_count',
      'st.total_positions',
      'st.sharpe',
      "st.extras->>'sortino'",
      "st.extras->>'calmar'",
      "st.extras->>'volatility'",
    ]) {
      expect(boardBranch).toContain(fallback)
    }
  })

  it('reports the oldest observation used by a mixed board row', () => {
    expect(boardBranch).toMatch(
      /WHEN st\.trader_id IS NULL THEN lp\.scraped_at[\s\S]*ELSE LEAST\(lp\.scraped_at, st\.as_of\)[\s\S]*AS as_of/
    )
    expect(boardBranch).not.toMatch(/^\s*lp\.scraped_at\s+AS as_of/m)
    expect(firstPartyBranch).toMatch(/^\s*st\.as_of\s+AS as_of/m)
  })

  it('retains active-serving, currency, NULL, and first-party boundaries', () => {
    expect(boardBranch).toContain("WHERE s.serving_mode = 'serving'")
    expect(boardBranch).toContain("AND s.status = 'active'")
    expect(firstPartyBranch).toContain("WHERE s.serving_mode = 'serving'")
    expect(firstPartyBranch).toContain("AND s.status = 'active'")
    expect(
      migration.match(/s\.currency = ANY \(ARRAY\['USDT','USDx','USDC','USD'\]\)/g)
    ).toHaveLength(2)
    expect(migration).toContain("st.extras->>'provenance' = 'first_party'")
    expect(migration.match(/st\.as_of > now\(\) - interval '48 hours'/g)).toHaveLength(3)
    expect(migration.match(/THEN NULL::numeric/g)).toHaveLength(6)
    expect(viewDefinition.match(/UNION ALL/g)).toHaveLength(1)
  })

  it('preserves view identity, exact membership, and service-role access', () => {
    expect(migration).toContain('CREATE OR REPLACE VIEW arena.score_inputs AS')
    expect(migration).not.toMatch(/DROP\s+(?:VIEW|FUNCTION)/i)
    expect(migration).toContain("SELECT 'arena.score_inputs'::regclass::oid AS view_oid")
    expect(migration).toContain('IF v_oid_after IS DISTINCT FROM v_oid_before THEN')
    expect(migration).toContain('IF v_rows_after IS DISTINCT FROM v_rows_before THEN')
    expect(migration).toContain('stale-fallback expiry changed score-input rows')
    expect(migration).toContain('CREATE TEMP TABLE score_input_membership_before')
    expect(migration.match(/'rpc48'::text AS surface/g)).toHaveLength(2)
    expect(migration.match(/board_rank <= 1000/g)).toHaveLength(2)
    expect(migration.match(/^\s*EXCEPT ALL/gm)).toHaveLength(2)
    expect(migration).toContain('stale-fallback expiry changed view or default RPC48 membership')
    expect(migration).toContain('GRANT SELECT ON arena.score_inputs TO service_role')
    expect(migration).toContain(
      "has_table_privilege('service_role', 'arena.score_inputs', 'SELECT')"
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
