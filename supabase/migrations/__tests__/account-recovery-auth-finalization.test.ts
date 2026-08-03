import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260729072000_account_recovery_auth_finalization.sql'
  ),
  'utf8'
)
const proof = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/__tests__/account-recovery-auth-finalization.pg17.sh'
  ),
  'utf8'
)

describe('account recovery/deletion finalization authority', () => {
  it('persists recovery Auth, billing scope, deletion billing, and hard-delete fences', () => {
    expect(migration).toContain('recovery_billing_may_have_changed boolean')
    expect(migration).toContain("'auth_compensation_required'")
    expect(migration).toContain('CREATE TABLE public.account_recovery_password_guards')
    expect(migration).toContain('REFERENCES auth.users(id) ON DELETE CASCADE')
    expect(migration).toContain('CREATE TABLE public.account_deletion_auth_fences')
    expect(migration).toContain(
      "state text NOT NULL CHECK (state IN ('prepared', 'billing_pending'"
    )
    expect(migration).toContain('worker_attempt_id uuid')
    expect(migration).toContain('CREATE TABLE public.account_hard_deletion_fences')
    expect(migration).toContain('CREATE TABLE public.account_auth_reconciliation_scheduler')
    expect(migration).toContain("'expired_manual'")
    expect(migration).toContain("state='hard_delete_pending'")
  })

  it('closes every legacy/public bypass and inventories every authority RPC', () => {
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, authenticator, service_role;')
    for (const name of [
      'resolve_account_recovery_capability_atomic',
      'require_account_recovery_auth_compensation_atomic',
      'arm_account_recovery_billing_atomic',
      'resolve_account_recovery_compensation_scope_atomic',
      'resolve_account_deletion_capability_atomic',
      'claim_account_hard_deletion_atomic',
      'arm_account_hard_deletion_atomic',
      'finalize_account_hard_deletion_worker_atomic',
      'finalize_account_hard_deletion_takeover_atomic',
      'list_account_hard_deletion_candidates_atomic',
      'list_account_auth_reconciliation_candidates_atomic',
      'resolve_account_auth_reconciliation_authority_atomic',
    ]) {
      expect(migration).toContain(`public.${name}`)
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${name}`)
    }
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.complete_account_hard_deletion_atomic/
    )
    expect(migration).toContain('relation.relforcerowsecurity')
    expect(migration).toContain("'recovery_billing_may_have_changed'")
  })

  it('proves the two-phase, bcrypt, worker lease, and hard-delete takeover contracts on PG17', () => {
    expect(proof).toContain('$two_phase_recovery_and_billing$')
    expect(proof).toContain('$password_bcrypt_contract$')
    expect(proof).toContain('$deletion_billing_saga_and_worker_lease$')
    expect(proof).toContain('$hard_delete_expired_claim_revalidates$')
    expect(proof).toContain('$hard_delete_takeover_after_restore_blocked$')
    expect(proof).toContain('$completed_recovery_can_be_superseded_by_new_deletion$')
    expect(proof).toContain('$expired_recovery_capability_cannot_resume$')
    expect(proof).toContain('$expired_deletion_capability_cannot_schedule$')
    expect(proof).toContain('$cron_terminalizes_unattended_expiry$')
    expect(proof).toContain('$missing_profile_auth_authority_is_fail_closed$')
    expect(proof).toContain('$bounded_candidate_rotation_is_fair$')
    expect(proof).toContain('$long_lived_auth_ban_authority$')
    expect(proof).toContain('$hard_delete_worker_finalizer_is_atomic$')
    expect(proof).toContain('$hard_delete_takeover_finalizer_is_exact$')
    expect(proof).toContain('$hard_delete_finalizer_rolls_back_as_one_unit$')
    expect(proof).toContain('$transactional_replay_fail_closed$')
  })
})
