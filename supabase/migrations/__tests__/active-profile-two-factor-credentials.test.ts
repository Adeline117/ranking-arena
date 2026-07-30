import fs from 'node:fs'
import path from 'node:path'

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260729163500_active_profile_two_factor_credentials.sql'
  ),
  'utf8'
)
const routeSources = [
  'app/api/settings/2fa/setup/route.ts',
  'app/api/settings/2fa/verify/route.ts',
  'app/api/settings/2fa/backup-codes/route.ts',
  'app/api/settings/2fa/disable/route.ts',
].map((file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8'))

const functionNames = [
  'read_two_factor_enrollment_secret',
  'stage_two_factor_enrollment_secret_atomic',
  'enable_two_factor_credentials_atomic',
  'rotate_two_factor_backup_codes_atomic',
  'disable_two_factor_credentials_atomic',
]

describe('active-profile 2FA credential authority', () => {
  it('locks lifecycle, Auth, profile, then the 2FA namespace', () => {
    expect(migration).toMatch(
      /lock_active_two_factor_profile[\s\S]*?'account-recovery-admission:' \|\| p_user_id::text[\s\S]*?FROM auth\.users AS auth_user[\s\S]*?FOR SHARE;[\s\S]*?FROM public\.user_profiles AS profile[\s\S]*?FOR UPDATE;[\s\S]*?'two-factor-credentials:' \|\| p_user_id::text/
    )
    expect(migration).toContain('active-profile 2FA lock ordering drifted')
  })

  it('rejects every suspended representation before taking credential locks', () => {
    const source = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.lock_active_two_factor_profile'
    )
    const suspended = migration.indexOf('v_profile.banned_at IS NOT NULL', source)
    const credentialLock = migration.indexOf("'two-factor-credentials:' || p_user_id::text", source)

    expect(suspended).toBeGreaterThan(source)
    expect(credentialLock).toBeGreaterThan(suspended)
    expect(migration).toContain('v_profile.deleted_at IS NOT NULL')
    expect(migration).toContain('v_profile.is_banned')
    expect(migration).toContain('v_profile.ban_expires_at > v_now')
  })

  it('routes all five secret operations through the shared active authority', () => {
    for (const functionName of functionNames) {
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`)
      const next = migration.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1)
      const body = migration.slice(start, next === -1 ? undefined : next)

      expect(start).toBeGreaterThan(0)
      expect(body).toContain('public.lock_active_two_factor_profile(p_user_id)')
      expect(body).toContain("v_status IS DISTINCT FROM 'active'")
    }
  })

  it('takes secret and backup row locks only after the namespace authority', () => {
    expect(migration).toMatch(
      /enable_two_factor_credentials_atomic[\s\S]*?lock_active_two_factor_profile\(p_user_id\)[\s\S]*?FROM public\.user_2fa_secrets AS secret_row[\s\S]*?FOR UPDATE;[\s\S]*?FROM public\.backup_codes AS backup_code[\s\S]*?FOR UPDATE;/
    )
    expect(migration).toMatch(
      /disable_two_factor_credentials_atomic[\s\S]*?lock_active_two_factor_profile\(p_user_id\)[\s\S]*?FROM public\.user_2fa_secrets AS secret_row[\s\S]*?FOR UPDATE;[\s\S]*?FROM public\.backup_codes AS backup_code[\s\S]*?FOR UPDATE;/
    )
  })

  it('keeps the helper private and all public RPCs service-only', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.lock_active_two_factor_profile\(uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated, authenticator, service_role;/
    )
    for (const functionName of functionNames) {
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${functionName}`)
    }
    expect(migration).toContain('active-profile 2FA function ACL drifted')
  })

  it('handles suspended typed ACKs and rechecks before every credential release', () => {
    for (const source of routeSources) {
      expect(source).toContain("status === 'suspended'")
      expect(source).toContain('hasActiveTwoFactorProfile(user)')
      expect(source).toContain("{ error: 'Account unavailable' }")
      expect(source.lastIndexOf('.rpc(')).toBeLessThan(
        source.indexOf('hasActiveTwoFactorProfile(user)')
      )
    }
  })
})
