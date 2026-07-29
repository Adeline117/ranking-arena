import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729055000_account_recovery_auth_manual_review.sql'),
  'utf8'
)

describe('account recovery Auth manual-review boundary', () => {
  it('is service-only and binds every review to an exact admitted operation', () => {
    expect(migration).toContain('public.record_account_recovery_auth_manual_review(uuid,uuid,text)')
    expect(migration).toContain("IS DISTINCT FROM 'service_role'")
    expect(migration).toContain('WHERE admission.operation_id = p_operation_id')
    expect(migration).toContain('v_admission.user_id IS DISTINCT FROM p_user_id')
    expect(migration).toContain("'account-recovery-admission:' || p_user_id::text")
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION\n  public.record_account_recovery_auth_manual_review(uuid, uuid, text)\nFROM PUBLIC, anon, authenticated, authenticator'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION\n  public.record_account_recovery_auth_manual_review(uuid, uuid, text)\nTO service_role'
    )
  })

  it('allows only the two reviewed failure states and persists exact immutable identity', () => {
    expect(migration).toContain("'auth_reban_failed'")
    expect(migration).toContain("'finish_outcome_unknown'")
    expect(migration).toContain("'account_recovery:' || p_reason_key")
    expect(migration).toContain("'user_id', p_user_id")
    expect(migration).toContain("'operation_id', p_operation_id")
    expect(migration).toContain("'admission_state', v_admission.state")
    expect(migration).toContain('ON CONFLICT (object_type, object_id, reason_key) DO NOTHING')
    expect(migration).toContain("RETURN CASE WHEN v_inserted THEN 'recorded' ELSE 'existing' END")
  })
})
