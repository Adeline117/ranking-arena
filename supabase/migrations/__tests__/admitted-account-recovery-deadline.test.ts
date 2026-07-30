import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationName = '20260729173500_admitted_account_recovery_deadline.sql'
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const pg17Proof = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/__tests__/admitted-account-recovery-deadline.pg17.sh'
  ),
  'utf8'
)

describe('admitted account recovery deadline', () => {
  it('restores only the exact live admission that won before the deadline', () => {
    expect(migration).toContain("admission.state = 'claimed'")
    expect(migration).toContain(
      'admission.recovery_token_hash\n      IS NOT DISTINCT FROM p_recovery_token_hash'
    )
    expect(migration).toContain('v_admission.claimed_at >= v_profile.deletion_scheduled_at')
    expect(migration).toContain('v_admission.lease_expires_at <= v_now')
    expect(migration).toContain('token.expires_at > v_admission.claimed_at')
  })

  it('keeps the helper service-only and hardens its execution context', () => {
    expect(migration).toContain("COALESCE((SELECT auth.role()), '')")
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('SET row_security = off')
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.restore_pending_account(uuid, text)')
    expect(migration).toContain('TO service_role;')
  })

  it('proves a pre-deadline token claim can finish after expiry in PostgreSQL 17', () => {
    expect(pg17Proof).toContain('$deadline_crossing_finish$')
    expect(pg17Proof).toContain('$expired_without_admission$')
    expect(pg17Proof).toContain('Admitted account recovery deadline PostgreSQL 17 proof passed')
  })
})
