import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationName = '20260729075300_account_hard_delete_recovery_barrier.sql'
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const route = readFileSync(
  resolve(process.cwd(), 'app/api/cron/cleanup-deleted-accounts/route.ts'),
  'utf8'
)
const runner = readFileSync(
  resolve(process.cwd(), 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/__tests__/account-hard-delete-recovery-barrier.pg17.sh'
  ),
  'utf8'
)

describe('account hard-delete recovery barrier', () => {
  it('serializes on the exact recovery admission key before locking the profile', () => {
    expect(migration).toContain("'account-recovery-admission:' || p_user_id::text")
    const hardDelete = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.admit_expired_account_hard_delete_atomic'
      )
    )
    expect(hardDelete.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      hardDelete.indexOf('v_now := pg_catalog.clock_timestamp()')
    )
    expect(hardDelete.indexOf('v_now := pg_catalog.clock_timestamp()')).toBeLessThan(
      hardDelete.indexOf('FROM public.user_profiles AS profile')
    )
    expect(migration).toContain("admission.state = 'claimed'")
    expect(migration).toContain('admission.lease_expires_at > v_now')
    expect(migration).toContain("v_status := 'recovery_in_progress'")
    expect(migration).toContain("v_status := 'ready'")
  })

  it('samples recovery claim time only after the shared advisory lock', () => {
    expect(migration).toContain('RENAME TO claim_account_recovery_admission_atomic_locked_impl')
    const wrapper = migration.slice(
      migration.indexOf('CREATE FUNCTION public.claim_account_recovery_admission_atomic('),
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.admit_expired_account_hard_delete_atomic'
      )
    )
    expect(wrapper.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      wrapper.indexOf('claim_account_recovery_admission_atomic_locked_impl')
    )
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION\n  public.claim_account_recovery_admission_atomic_locked_impl'
    )
  })

  it('is service-only and returns an exact subject acknowledgement', () => {
    expect(migration).toContain("COALESCE((SELECT auth.role()), '')")
    expect(migration).toContain('SET row_security = off')
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.admit_expired_account_hard_delete_atomic(uuid)'
    )
    expect(migration).toContain('TO service_role;')
    expect(migration).toContain("'user_id', p_user_id")
  })

  it('gates the cron before its first billing or destructive operation', () => {
    const admission = route.indexOf("'admit_expired_account_hard_delete_atomic'")
    expect(admission).toBeGreaterThan(0)
    expect(admission).toBeLessThan(route.indexOf(".from('subscriptions')"))
    expect(admission).toBeLessThan(
      route.indexOf('await expireOpenSubscriptionCheckouts', admission)
    )
    expect(admission).toBeLessThan(route.indexOf("'purge_deleted_account_group_edges'"))
    expect(admission).toBeLessThan(route.indexOf('deleteUser(account.id)'))
    expect(route).toContain('isExactHardDeleteAdmissionResult(admission, account.id)')
  })

  it('is included in the ordered predeploy manifest', () => {
    const predeploy = runner.match(/PREDEPLOY_MIGRATIONS=\(([\s\S]*?)\n\)/)?.[1] ?? ''
    expect(predeploy).toContain(migrationName)
  })

  it('proves deadline-crossing recovery exclusion and ready admission in PostgreSQL 17', () => {
    expect(pg17Proof).toContain('$deadline_crossing_recovery$')
    expect(pg17Proof).toContain('recovery_in_progress')
    expect(pg17Proof).toContain('$no_claim_is_ready$')
    expect(pg17Proof).toContain('$queued_claim_uses_post_lock_clock$')
    expect(pg17Proof).toContain('Account hard-delete recovery barrier PostgreSQL 17 proof passed')
  })
})
