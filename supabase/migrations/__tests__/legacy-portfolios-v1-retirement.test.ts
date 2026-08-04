import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260803212000_legacy_portfolios_v1_retirement.sql'),
  'utf8'
)
const route = readFileSync(join(process.cwd(), 'app/api/portfolio/route.ts'), 'utf8')
const exportRoute = readFileSync(join(process.cwd(), 'app/api/settings/export/route.ts'), 'utf8')
const syncRoute = readFileSync(join(process.cwd(), 'app/api/portfolio/sync/route.ts'), 'utf8')
const positionsRoute = readFileSync(
  join(process.cwd(), 'app/api/portfolio/positions/route.ts'),
  'utf8'
)
const snapshotsRoute = readFileSync(
  join(process.cwd(), 'app/api/portfolio/snapshots/route.ts'),
  'utf8'
)
const cronRoute = readFileSync(
  join(process.cwd(), 'app/api/cron/aggregate-portfolio-snapshots/route.ts'),
  'utf8'
)
const vercel = readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')
const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
const workerTransport = readFileSync(
  join(process.cwd(), 'lib/exchange/ccxt-read-transport.ts'),
  'utf8'
)

describe('legacy portfolio V1 retirement', () => {
  it('preserves rows while removing every browser and non-owner ACL path', () => {
    expect(migration).toContain('DO $revoke_non_owner_table_acl$')
    expect(migration).toContain('DO $revoke_non_owner_column_acl$')
    expect(migration).toContain('DO $drop_legacy_portfolio_policies$')
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role')
    expect(migration).not.toMatch(/DELETE FROM public\.user_portfolios[\s\S]*WHERE\s+TRUE/i)
    expect(migration).not.toMatch(/\bTRUNCATE\s+TABLE\b/i)
  })

  it('exposes metadata-only inventory and a versioned owner-scoped delete capability', () => {
    expect(migration).toMatch(
      /GRANT SELECT \(id, user_id, exchange, label, created_at\)[\s\S]*ON TABLE public\.user_portfolios[\s\S]*TO service_role/
    )
    expect(migration).not.toMatch(/GRANT SELECT(?:, DELETE)? ON TABLE public\.user_portfolios/)
    expect(migration).toContain('public.delete_legacy_portfolio_v1')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('portfolio.user_id = p_user_id')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.delete_legacy_portfolio_v1')
    expect(route).toContain(".rpc('delete_legacy_portfolio_v1'")
    expect(route).not.toContain(".from('user_portfolios')\n      .delete()")
  })

  it('exports retained owner data only through an exact non-secret service capability', () => {
    expect(migration).toContain('public.export_legacy_portfolio_data_v1')
    expect(migration).toContain(
      'ALTER FUNCTION public.export_legacy_portfolio_data_v1(uuid) OWNER TO postgres'
    )
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('WHERE portfolio.user_id = p_user_id')
    expect(migration).toContain('position_row.entry_price::text')
    expect(migration).toContain('snapshot_row.total_equity::text')
    expect(migration).toContain('v_snapshot_count > 250000')
    expect(migration).toContain("USING ERRCODE = '54000'")
    expect(migration).toContain('DO $revoke_unexpected_legacy_portfolio_function_acl$')
    expect(migration).toContain('unexpected legacy-portfolio function overloads')
    expect(migration).toContain('legacy portfolio overload inventory is not exact')
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.export_legacy_portfolio_data_v1\(uuid\)[\s\S]*TO service_role/
    )
    expect(migration).not.toMatch(
      /jsonb_build_object\([\s\S]{0,120}'api_(?:key|secret|passphrase)_encrypted'/
    )
    expect(exportRoute).toContain(".rpc('export_legacy_portfolio_data_v1'")
    expect(exportRoute).toContain('parseLegacyPortfolioExport')
  })

  it('retires every credential-derived writer/read projection and stale cron', () => {
    expect(route).toContain("return retiredPortfolioWrite('connect')")
    expect(syncRoute).toContain("return retiredPortfolioWrite('sync')")
    expect(positionsRoute).toContain("retiredPortfolioCapability('positions')")
    expect(snapshotsRoute).toContain("retiredPortfolioCapability('snapshots')")
    expect(cronRoute).toContain("status: 'retired'")
    expect(cronRoute).not.toContain('getSupabaseAdmin')
    expect(vercel).not.toContain('/api/cron/aggregate-portfolio-snapshots')
    expect(existsSync(join(process.cwd(), 'lib/portfolio/exchange-sync.ts'))).toBe(false)
    expect(existsSync(join(process.cwd(), 'lib/exchange/secure-encryption.ts'))).toBe(false)
    expect(workerTransport).not.toContain("from '@/lib/exchange/secure-encryption'")
    expect(workerTransport).not.toContain('syncExchangePortfolio')
    expect(workerTransport).not.toContain('user_portfolios')
  })

  it('wires an isolated PostgreSQL 17 proof into CI', () => {
    expect(packageJson).toContain('qa:legacy-portfolio-retirement-pg17')
    expect(ci).toContain('npm run qa:legacy-portfolio-retirement-pg17')
  })
})
