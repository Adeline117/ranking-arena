import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260729157500_atomic_admin_user_sanctions.sql'),
  'utf8'
)
const banRoute = readFileSync(
  resolve(process.cwd(), 'app/api/admin/users/[id]/ban/route.ts'),
  'utf8'
)
const unbanRoute = readFileSync(
  resolve(process.cwd(), 'app/api/admin/users/[id]/unban/route.ts'),
  'utf8'
)
const moderateRoute = readFileSync(
  resolve(process.cwd(), 'app/api/admin/moderate/route.ts'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/__tests__/atomic-admin-user-sanctions.pg17.sh'),
  'utf8'
)

describe('atomic administrator user sanctions', () => {
  it('orders lifecycle, Auth, and profile locks before changing sanction state', () => {
    const authority = migration.slice(
      migration.indexOf('CREATE FUNCTION public.set_admin_user_sanction_atomic'),
      migration.indexOf('ALTER FUNCTION public.set_admin_user_sanction_atomic')
    )
    expect(authority).toContain("'account-recovery-admission:' || v_user_id::text")
    expect(authority).toContain('ORDER BY required_id')
    expect(authority).toContain('ORDER BY auth_user.id')
    expect(authority).toContain('ORDER BY profile.id')
    expect(authority.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      authority.indexOf('FROM auth.users AS auth_user')
    )
    expect(authority.indexOf('FROM auth.users AS auth_user')).toBeLessThan(
      authority.indexOf('FROM public.user_profiles AS profile')
    )
    expect(authority.indexOf('FROM public.user_profiles AS profile')).toBeLessThan(
      authority.indexOf('UPDATE public.user_profiles AS target_profile')
    )
  })

  it('commits modern and legacy state with its audit record in one function', () => {
    expect(migration).toMatch(
      /SET banned_at = v_now,[\s\S]*is_banned = true,[\s\S]*ban_expires_at = NULL,[\s\S]*banned_reason = v_reason,[\s\S]*banned_by = p_actor_id/
    )
    expect(migration).toMatch(
      /SET banned_at = NULL,[\s\S]*is_banned = false,[\s\S]*ban_expires_at = NULL,[\s\S]*banned_reason = NULL,[\s\S]*banned_by = NULL/
    )
    expect(migration.match(/INSERT INTO public\.admin_logs/g)).toHaveLength(3)
    expect(migration).toContain("'ban_user'")
    expect(migration).toContain("'unban_user'")
    expect(migration).toContain('GET DIAGNOSTICS v_affected_count = ROW_COUNT')
  })

  it('exposes only a fail-closed service authority', () => {
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('SET row_security = off')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*set_admin_user_sanction_atomic\(uuid, uuid, text, text\)[\s\S]*FROM PUBLIC, anon, authenticated, authenticator;[\s\S]*GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/
    )
  })

  it('turns inverted legacy lifecycle writers into retryable conflicts', () => {
    const lockFunction = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.lock_account_lifecycle_subject_transition'
      ),
      migration.indexOf('ALTER FUNCTION public.lock_account_lifecycle_subject_transition')
    )
    expect(lockFunction).toContain('pg_try_advisory_xact_lock')
    expect(lockFunction).toContain("ERRCODE = '40001'")
    expect(lockFunction).toContain('NEW.is_banned := true')
    expect(lockFunction).toContain('NEW.is_banned := false')
    expect(lockFunction).toContain('NEW.banned_at := pg_catalog.clock_timestamp()')
    expect(lockFunction).not.toMatch(/\bPERFORM\s+pg_catalog\.pg_advisory_xact_lock/)
  })

  it('routes every live administrator ban/unban through the authority', () => {
    expect(banRoute).toContain('setAdminUserSanctionAtomic')
    expect(unbanRoute).toContain('setAdminUserSanctionAtomic')
    expect(banRoute).not.toContain(".from('user_profiles')")
    expect(unbanRoute).not.toContain(".from('user_profiles')")
    expect(banRoute).not.toContain(".from('admin_logs')")
    expect(unbanRoute).not.toContain(".from('admin_logs')")

    expect(moderateRoute).toContain('ADMIN_MODERATE_ENDPOINT_RETIRED')
    expect(moderateRoute).not.toContain('setAdminUserSanctionAtomic')
    expect(moderateRoute).not.toContain(".from('user_profiles')")
    expect(moderateRoute).not.toContain(".from('admin_logs')")
  })

  it('ships executable PostgreSQL 17 rollback and concurrency proofs', () => {
    expect(pg17Proof).toContain('fail_admin_log_insert')
    expect(pg17Proof).toContain('wait_for_subject_lock')
    expect(pg17Proof).toContain('inverted-writer')
    expect(pg17Proof).toContain('opposing-sanction')
    expect(pg17Proof).toContain('atomic administrator user sanctions PG17 proof passed')
  })
})
