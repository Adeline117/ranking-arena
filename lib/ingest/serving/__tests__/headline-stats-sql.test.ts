import { HEADLINE_STATS_UPSERT_SQL } from '../headline-stats-sql'

/**
 * Static guard for the native-board headline upsert. The executable proof
 * against a real PostgreSQL 17 cluster is `npm run qa:headline-stats-as-of-pg17`.
 */
describe('HEADLINE_STATS_UPSERT_SQL as_of semantics', () => {
  const asOfClause = (() => {
    const start = HEADLINE_STATS_UPSERT_SQL.indexOf('as_of           = CASE WHEN')
    const end = HEADLINE_STATS_UPSERT_SQL.indexOf('END,', start)
    return HEADLINE_STATS_UPSERT_SQL.slice(start, end)
  })()

  it('keeps LEAST only for retained headline columns', () => {
    expect(asOfClause).toContain('THEN LEAST(arena.trader_stats.as_of, EXCLUDED.as_of)')
    for (const column of ['roi', 'pnl', 'win_rate', 'mdd', 'sharpe', 'holding_duration_avg']) {
      expect(asOfClause).toContain(
        `(EXCLUDED.${column} IS NULL AND arena.trader_stats.${column} IS NOT NULL)`
      )
    }
  })

  it('never freezes as_of on profile-only state (extras / profit_share_rate / trading_preferences)', () => {
    expect(asOfClause).not.toMatch(/extras/)
    expect(asOfClause).not.toMatch(/profit_share_rate/)
    expect(asOfClause).not.toMatch(/trading_preferences/)
  })

  it('still merges extras instead of clobbering profile keys', () => {
    expect(HEADLINE_STATS_UPSERT_SQL).toContain(
      "ELSE COALESCE(arena.trader_stats.extras, '{}'::jsonb) || EXCLUDED.extras END"
    )
  })
})
