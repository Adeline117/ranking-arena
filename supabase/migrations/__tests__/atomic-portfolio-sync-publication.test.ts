import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729057000_atomic_portfolio_sync_publication.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/atomic-portfolio-sync-publication.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const route = readFileSync(resolve(root, 'app/api/portfolio/sync/route.ts'), 'utf8')
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  const next = migration.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1)
  const end = next >= 0 ? next : migration.indexOf('ALTER FUNCTION public.', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('atomic portfolio sync publication migration', () => {
  it('ships the ordered predeploy migration after its schema dependencies', () => {
    expect(runner).toContain(migrationName)
    expect(runner.indexOf(migrationName)).toBeGreaterThan(
      runner.indexOf('20260729056000_atomic_two_factor_credentials.sql')
    )
  })

  it('exposes only service-role generation and publication RPCs', () => {
    for (const name of [
      'claim_portfolio_sync_generation_atomic',
      'publish_portfolio_sync_atomic',
    ]) {
      const body = functionBody(name)
      expect(body).toContain('SECURITY DEFINER')
      expect(body).toContain('SET search_path = pg_catalog, pg_temp')
      expect(body).toContain('SET row_security = off')
      expect(body).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION\\s+public\\.${name}\\(`))
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION\\s+public\\.${name}\\(`))
    }
  })

  it('serializes claims and rejects stale or unclaimed publications', () => {
    const claim = functionBody('claim_portfolio_sync_generation_atomic')
    const publish = functionBody('publish_portfolio_sync_atomic')

    expect(claim).toContain('FOR UPDATE')
    expect(claim).toContain('sync_generation = portfolio.sync_generation + 1')
    expect(publish).toContain('FOR UPDATE')
    expect(publish).toContain("RETURN pg_catalog.jsonb_build_object(\n      'status', 'superseded'")
    expect(publish).toContain("'status', 'invalid_generation'")
  })

  it('publishes positions, pruning, equity snapshot, and watermark in one function', () => {
    const publish = functionBody('publish_portfolio_sync_atomic')
    const upsert = publish.indexOf('INSERT INTO public.user_positions')
    const prune = publish.indexOf('DELETE FROM public.user_positions')
    const snapshot = publish.indexOf('INSERT INTO public.user_portfolio_snapshots')
    const watermark = publish.indexOf('UPDATE public.user_portfolios')

    expect(upsert).toBeGreaterThanOrEqual(0)
    expect(prune).toBeGreaterThan(upsert)
    expect(snapshot).toBeGreaterThan(prune)
    expect(watermark).toBeGreaterThan(snapshot)
    expect(publish).not.toContain('EXCEPTION WHEN')
  })

  it('routes every financial projection through the atomic RPC and validates its ACK', () => {
    expect(route).toContain("'claim_portfolio_sync_generation_atomic'")
    expect(route).toContain("'publish_active_portfolio_sync_atomic'")
    expect(route).not.toContain(".from('user_positions')")
    expect(route).not.toContain(".from('user_portfolio_snapshots')")
    expect(route).toContain('if (claimError || !claim)')
    expect(route).toContain('if (publicationError || !publication)')
    expect(route).toContain('publication.positionCount !== result.positions.length')
  })

  it('keeps generated types aligned with the new schema and RPCs', () => {
    for (const marker of [
      'sync_generation: number',
      'published_sync_generation: number',
      'last_synced_at: string | null',
      'claim_portfolio_sync_generation_atomic:',
      'publish_portfolio_sync_atomic:',
    ]) {
      expect(databaseTypes).toContain(marker)
    }
  })

  it('proves concurrent claims, rollback, zero rows, and ACLs on PostgreSQL 17', () => {
    for (const marker of [
      'concurrent generation claims were not serialized',
      'snapshot failure rolls back position replacement and generation watermark',
      'failed publication restored every last-good projection',
      'authoritative empty snapshot publishes zero rows',
      'missing owner row is a zero-row not-found result',
      'authenticated caller cannot publish financial data',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
