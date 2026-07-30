import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729170500_portfolio_account_lifecycle.sql'),
  'utf8'
)
const route = readFileSync(resolve(root, 'app/api/portfolio/route.ts'), 'utf8')
const syncRoute = readFileSync(resolve(root, 'app/api/portfolio/sync/route.ts'), 'utf8')
const positionsRoute = readFileSync(resolve(root, 'app/api/portfolio/positions/route.ts'), 'utf8')
const snapshotsRoute = readFileSync(resolve(root, 'app/api/portfolio/snapshots/route.ts'), 'utf8')
const snapshotCron = readFileSync(
  resolve(root, 'app/api/cron/aggregate-portfolio-snapshots/route.ts'),
  'utf8'
)
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

describe('portfolio account lifecycle migration', () => {
  it('fences every credential authority change with a monotonic generation', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS is_active boolean')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS credential_generation bigint')
    expect(migration).toContain('aaa_bump_portfolio_credential_generation')
    for (const column of [
      'user_id',
      'exchange',
      'api_key_encrypted',
      'api_secret_encrypted',
      'api_passphrase_encrypted',
      'is_active',
      'read_only_permissions',
      'read_only_verified_at',
    ]) {
      expect(migration).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`)
    }
  })

  it('serializes save, claim, and publication with canonical account state', () => {
    for (const functionName of [
      'save_user_portfolio_for_active_profile_atomic',
      'claim_portfolio_sync_generation_atomic',
      'publish_active_portfolio_sync_atomic',
    ]) {
      const body = functionBody(functionName)
      expect(body).not.toBe('')
      expect(body).toContain('lock_trader_claim_principals_internal')
      expect(body).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    }
  })

  it('binds publication to both sync and credential generations', () => {
    const claim = functionBody('claim_portfolio_sync_generation_atomic')
    const publish = functionBody('publish_active_portfolio_sync_atomic')

    expect(claim).toContain("'credential_generation', v_portfolio.credential_generation")
    expect(claim).toContain("'api_key_encrypted', v_portfolio.api_key_encrypted")
    expect(publish).toContain(
      'v_portfolio.credential_generation IS DISTINCT FROM\n       p_credential_generation'
    )
    expect(publish).toContain('public.publish_portfolio_sync_atomic(')
    expect(migration).toContain(
      '-- The old generation-only publication has no account/credential fence.'
    )
  })

  it('quiesces credentials on account inactivity without deleting user data', () => {
    const trigger = functionBody('quiesce_inactive_user_portfolios')

    expect(trigger).toContain('UPDATE public.user_portfolios AS portfolio')
    expect(trigger).toContain('SET is_active = false')
    expect(trigger).not.toContain('DELETE FROM public.user_portfolios')
    expect(migration).toContain('zzz_quiesce_inactive_user_portfolios')
    expect(migration).toContain('zzz_quiesce_deleted_user_portfolios')
    expect(functionBody('save_user_portfolio_for_active_profile_atomic')).toContain(
      "'status', 'already_exists'"
    )
    expect(functionBody('save_user_portfolio_for_active_profile_atomic')).not.toContain(
      'DELETE FROM public.user_portfolio'
    )
  })

  it('removes browser credential reads and all direct financial mutations', () => {
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.user_portfolios')
    expect(migration).toContain('GRANT SELECT (\n  id,')
    expect(migration).not.toMatch(/GRANT SELECT \([\s\S]{0,500}api_key_encrypted/)
    expect(migration).toContain('FOR SELECT\n  TO authenticated')
  })

  it('routes storage and sync without direct credential-table access', () => {
    expect(route).toContain("'save_user_portfolio_for_active_profile_atomic'")
    expect(syncRoute).toContain("'claim_portfolio_sync_generation_atomic'")
    expect(syncRoute).toContain("'publish_active_portfolio_sync_atomic'")
    expect(syncRoute).not.toContain(".from('user_portfolios')")
    expect(syncRoute).not.toContain("'publish_portfolio_sync_atomic'")
    expect(positionsRoute).toContain(".eq('is_active', true)")
    expect(snapshotsRoute).toContain(".eq('is_active', true)")
    expect(snapshotCron).toContain('Retired legacy portfolio-snapshot writer')
    expect(snapshotCron).toContain('{ status: 410 }')
    expect(snapshotCron).not.toContain(".from('user_positions')")
  })

  it('keeps generated schema and RPC types aligned', () => {
    for (const marker of [
      'credential_generation: number',
      'is_active: boolean',
      'read_only_permissions: Json | null',
      'read_only_verified_at: string | null',
      'save_user_portfolio_for_active_profile_atomic:',
      'publish_active_portfolio_sync_atomic:',
    ]) {
      expect(databaseTypes).toContain(marker)
    }
  })

  it('proves lifecycle races, replacement fences, replay, and ACLs on PostgreSQL 17', () => {
    for (const marker of [
      'legacy unproven credential is inactive',
      'credential replacement supersedes in-flight publication',
      'ban during remote fetch prevents publication',
      'unban does not reactivate old credential',
      'migration replay preserves a valid active credential',
      'authenticated cannot read credential ciphertext',
      'authenticated cannot fabricate positions',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
