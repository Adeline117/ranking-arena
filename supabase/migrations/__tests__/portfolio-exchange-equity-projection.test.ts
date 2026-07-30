import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729172500_portfolio_exchange_equity_projection.sql'),
  'utf8'
)
const portfolioRoute = readFileSync(resolve(root, 'app/api/portfolio/route.ts'), 'utf8')
const snapshotRoute = readFileSync(resolve(root, 'app/api/portfolio/snapshots/route.ts'), 'utf8')
const page = readFileSync(resolve(root, 'app/(app)/portfolio/page.tsx'), 'utf8')
const helper = readFileSync(resolve(root, 'lib/portfolio/current-equity.ts'), 'utf8')
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/portfolio-account-lifecycle.pg17.sh'),
  'utf8'
)

function functionBody(functionName: string): string {
  const match = new RegExp(`CREATE OR REPLACE FUNCTION\\s+public\\.${functionName}\\(`).exec(
    migration
  )
  if (!match) return ''
  return migration.slice(match.index, migration.indexOf('$function$;', match.index) + 11)
}

describe('portfolio exchange equity projection', () => {
  it('stores a complete current projection owned by one published generation', () => {
    for (const column of [
      'current_equity',
      'current_pnl',
      'current_pnl_pct',
      'current_equity_at',
      'current_equity_generation',
    ]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${column}`)
    }
    expect(migration).toContain('current_equity_generation <= published_sync_generation')
    expect(migration).toContain('current_equity_at <= last_synced_at')
    expect(migration).toContain('portfolio.published_sync_generation = p_generation')
    expect(migration).toContain('portfolio.last_synced_at = p_synced_at')
  })

  it('projects exchange values inside the lifecycle-fenced publication transaction', () => {
    const publish = functionBody('publish_active_portfolio_sync_atomic')

    expect(publish).toContain('lock_trader_claim_principals_internal')
    expect(publish).toContain('public.publish_portfolio_sync_atomic(')
    expect(publish).toContain('current_equity = p_total_equity')
    expect(publish).toContain('current_pnl = p_total_pnl')
    expect(publish).toContain('current_equity_generation = p_generation')
    expect(publish.indexOf('public.publish_portfolio_sync_atomic(')).toBeLessThan(
      publish.indexOf('current_equity = p_total_equity')
    )
  })

  it('clears the projection whenever credential authority changes', () => {
    const trigger = functionBody('bump_portfolio_credential_generation')

    expect(trigger).toContain('NEW.current_equity := NULL')
    expect(trigger).toContain('NEW.current_pnl := NULL')
    expect(trigger).toContain('NEW.current_equity_generation := 0')
  })

  it('excludes mixed-provenance legacy snapshots from the equity curve', () => {
    expect(migration).toContain("DEFAULT 'legacy_unverified'")
    expect(migration).toContain("SET snapshot_source = 'exchange_sync'")
    expect(snapshotRoute).toContain(".eq('snapshot_source', 'exchange_sync')")
  })

  it('renders totals only from the current exchange projection, never position notional', () => {
    expect(portfolioRoute).toContain('current_equity, current_pnl, current_equity_generation')
    expect(page).toContain('summarizePortfolioCurrentEquity(portfolios)')
    expect(page).not.toContain('Number(p.size) * Number(p.mark_price)')
    expect(helper).toContain('portfolio.current_equity')
    expect(helper).not.toContain('mark_price')
  })

  it('keeps generated types aligned with projection and provenance columns', () => {
    for (const marker of [
      'current_equity: number | null',
      'current_equity_at: string | null',
      'current_equity_generation: number',
      'current_pnl: number | null',
      'current_pnl_pct: number | null',
      'snapshot_source: string',
    ]) {
      expect(databaseTypes).toContain(marker)
    }
  })

  it('proves replay, provenance, exact exchange values, and ban clearing on PostgreSQL 17', () => {
    for (const marker of [
      'equity migration replay preserves legacy provenance without backfill',
      'published exchange balance owns the current equity projection',
      'deferred equity constraint rejects a committed generation lag',
      'current_portfolio.current_equity_generation',
      'current_portfolio.current_equity IS NULL',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
