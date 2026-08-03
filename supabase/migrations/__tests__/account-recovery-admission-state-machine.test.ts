import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260729022500_account_recovery_admission_state_machine.sql'
  ),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/__tests__/account-recovery-admission-state-machine.pg17.sh'
  ),
  'utf8'
)

describe('account recovery admission state machine migration', () => {
  it('retains one exact claimed operation per recovery subject', () => {
    expect(migration).toContain('CREATE TABLE public.account_recovery_admissions')
    expect(migration).toContain('operation_id uuid PRIMARY KEY')
    expect(migration).toContain('user_id uuid NOT NULL')
    expect(migration).toContain("state IN ('claimed', 'finished', 'aborted')")
    expect(migration).toContain('CREATE UNIQUE INDEX account_recovery_admissions_one_claimed_user')
    expect(migration).toContain("WHERE state = 'claimed'")
  })

  it('serializes claim, finish, and abort under the same user lock', () => {
    expect(migration.match(/account-recovery-admission:/g)).toHaveLength(3)
    expect(migration).toContain('public.claim_account_recovery_admission_atomic')
    expect(migration).toContain('public.finish_account_recovery_admission_atomic')
    expect(migration).toContain('public.abort_account_recovery_admission_atomic')
    expect(migration).toContain("RETURN 'busy'")
    expect(migration).toContain("RETURN 'claimed'")
    expect(migration).toContain("RETURN 'finished'")
    expect(migration).toContain("RETURN 'aborted'")
  })

  it('revalidates the exact unused token and restores only inside finish', () => {
    expect(migration).toContain('token.token_hash = p_recovery_token_hash')
    expect(migration).toContain('token.used_at IS NULL')
    expect(migration).toContain('token.expires_at > v_now')
    expect(migration).toContain('v_restored_user_id := public.restore_pending_account(')
    expect(migration).toContain('v_restored_user_id IS DISTINCT FROM p_user_id')
  })

  it('keeps all three transitions service-only with exact scalar returns', () => {
    expect(migration.match(/RETURNS text/g)).toHaveLength(3)
    expect(migration.match(/COALESCE\(\(SELECT auth\.role\(\)\), ''\)/g)).toHaveLength(3)
    expect(migration.match(/TO service_role;/g)).toHaveLength(3)
    expect(migration).toContain('FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('REVOKE ALL ON TABLE public.account_recovery_admissions')
  })

  it('proves two-request exclusion and retryable terminal ACKs in PostgreSQL 17', () => {
    expect(pg17Proof).toContain('$two_request_concurrency$')
    expect(pg17Proof).toContain('busy claimed')
    expect(pg17Proof).toContain('$abort_and_retry$')
    expect(pg17Proof).toContain('Account recovery admission PostgreSQL 17 concurrency proof passed')
  })
})
