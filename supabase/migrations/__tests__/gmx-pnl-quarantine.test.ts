import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260715232500_quarantine_gmx_mixed_pnl.sql'),
  'utf8'
)

describe('GMX mixed-PnL quarantine migration', () => {
  it('is atomic, bounded, and requires source contract v2', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("meta->>'pnl_contract_version' = '2'")
    expect(migration).toContain('SET LOCAL lock_timeout')
    expect(migration).toContain('SET LOCAL statement_timeout')
  })

  it('archives exact stats and both series stores before mutation', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS arena.trader_stats_quarantine')
    expect(migration).toContain('to_jsonb(stats)')
    expect(migration).toContain("'trader_series', series.trader_id")
    expect(migration).toContain("'trader_series_weekly', series.trader_id")
    expect(migration).toContain('GMX archive mismatch')
    expect(migration.indexOf('INSERT INTO arena.trader_stats_quarantine')).toBeLessThan(
      migration.indexOf('UPDATE arena.trader_stats AS stats')
    )
  })

  it('clears mixed typed values, risk provenance, and canonical pnl curves only for GMX', () => {
    for (const column of ['pnl', 'roi', 'sharpe', 'mdd']) {
      expect(migration).toContain(`${column} = NULL`)
    }
    for (const key of ['pnl_basis', 'realized_pnl_usd', 'risk_derivation', 'sortino']) {
      expect(migration).toContain(`- '${key}'`)
    }
    expect(migration).toContain("source.slug = 'gmx'")
    expect(migration).toContain("series.metric = 'pnl'")
    expect(migration).toContain('GMX cleanup mismatch')
  })

  it('guards the audited production population instead of accepting arbitrary scope', () => {
    expect(migration).toContain('v_stats_count BETWEEN 500 AND 600')
    expect(migration).toContain('v_daily_count BETWEEN 25000 AND 31000')
    expect(migration).toContain('v_weekly_count BETWEEN 700 AND 900')
  })
})
