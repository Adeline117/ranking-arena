import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729160000_trader_claim_account_lifecycle.sql'),
  'utf8'
)

describe('trader-claim account lifecycle authority', () => {
  it('keeps every public mutation service-only at runtime and in ACLs', () => {
    expect(
      migration.match(/COALESCE\(\(SELECT auth\.role\(\)\), ''\) IS DISTINCT FROM 'service_role'/g)
    ).toHaveLength(3)
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role, authenticator')
    expect(migration).toContain('TO service_role')
    expect(migration).toContain('SET row_security = off')
  })

  it('orders lifecycle, Auth, profile, claim, and identity locks consistently', () => {
    const helperStart = migration.indexOf(
      'CREATE FUNCTION public.lock_trader_claim_principals_internal'
    )
    const submitStart = migration.indexOf('CREATE FUNCTION public.submit_trader_claim(')
    const activateStart = migration.indexOf('CREATE FUNCTION public.activate_trader_claim(')
    const unlinkStart = migration.indexOf('CREATE FUNCTION public.unlink_linked_trader(')

    const helper = migration.slice(helperStart, submitStart)
    const activate = migration.slice(activateStart, unlinkStart)

    expect(helper.indexOf("'account-recovery-admission:' || v_user_id::text")).toBeLessThan(
      helper.indexOf('FROM auth.users AS auth_user')
    )
    expect(helper.indexOf('FROM auth.users AS auth_user')).toBeLessThan(
      helper.indexOf('FROM public.user_profiles AS profile')
    )
    expect(helper).toContain('ORDER BY supplied.user_id')
    expect(activate.indexOf('lock_trader_claim_principals_internal')).toBeLessThan(
      activate.indexOf('FOR UPDATE')
    )

    // The previously proven internals retain claim -> linked-trader ->
    // identity ordering, but are now called only while lifecycle/profile locks
    // are already held by the public wrappers.
    expect(migration).toContain('activate_trader_claim_without_account_lifecycle_internal')
    expect(migration).toContain('unlink_linked_trader_without_account_lifecycle_internal')
  })

  it('rejects deleted, modern-banned, and active legacy-banned principals', () => {
    expect(migration).toContain('v_deleted_at IS NOT NULL')
    expect(migration).toContain('v_banned_at IS NOT NULL')
    expect(migration).toContain('COALESCE(v_is_banned, false)')
    expect(migration).toContain('v_ban_expires_at IS NULL')
    expect(migration).toContain('v_ban_expires_at > pg_catalog.clock_timestamp()')
    expect(migration).toContain("MESSAGE = 'inactive trader claim principal'")
  })

  it('locks and revalidates the observed claimant before activation', () => {
    const activateStart = migration.indexOf('CREATE FUNCTION public.activate_trader_claim(')
    const unlinkStart = migration.indexOf('CREATE FUNCTION public.unlink_linked_trader(')
    const activate = migration.slice(activateStart, unlinkStart)

    expect(activate).toContain('INTO v_claimant_snapshot')
    expect(activate).toContain('INTO v_claimant_locked')
    expect(activate).toContain('FOR UPDATE')
    expect(activate).toContain('v_claimant_locked IS DISTINCT FROM v_claimant_snapshot')
    expect(activate).toContain("ERRCODE = '40001'")
  })

  it('keeps the established return types and strict timeout contracts', () => {
    expect(migration).toContain('RETURNS public.trader_claims')
    expect(migration).toContain('RETURNS jsonb')
    expect(migration).toContain('RETURNS TABLE (')
    expect(migration).toContain('remaining_count integer')
    expect(migration).toContain("SET statement_timeout = '20s'")
    expect(migration).toContain("SET statement_timeout = '30s'")
  })
})
