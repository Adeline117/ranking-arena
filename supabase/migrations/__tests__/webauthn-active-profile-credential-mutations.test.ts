import fs from 'node:fs'
import path from 'node:path'

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260729161000_webauthn_active_profile_credential_mutations.sql'
  ),
  'utf8'
)
const registrationRoute = fs.readFileSync(
  path.join(process.cwd(), 'app/api/auth/webauthn/registration-verify/route.ts'),
  'utf8'
)
const credentialsRoute = fs.readFileSync(
  path.join(process.cwd(), 'app/api/auth/webauthn/credentials/route.ts'),
  'utf8'
)

describe('WebAuthn active-profile credential mutation authority', () => {
  it('locks lifecycle, Auth, profile, then credential in the global order', () => {
    expect(migration).toContain("'account-recovery-admission:' || p_user_id::text")
    expect(migration).toMatch(
      /register_webauthn_credential_for_active_profile_atomic[\s\S]*?FROM auth\.users AS auth_user[\s\S]*?FOR SHARE;[\s\S]*?FROM public\.user_profiles AS profile[\s\S]*?FOR UPDATE;[\s\S]*?'webauthn-credential:' \|\| p_credential_id/
    )
    expect(migration).toMatch(
      /delete_webauthn_credential_for_active_profile_atomic[\s\S]*?FROM auth\.users AS auth_user[\s\S]*?FOR SHARE;[\s\S]*?FROM public\.user_profiles AS profile[\s\S]*?FOR UPDATE;[\s\S]*?FROM public\.user_passkeys AS passkey[\s\S]*?FOR UPDATE;/
    )
    expect(migration).toContain('WebAuthn registration source drifted')
    expect(migration).toContain('WebAuthn deletion source drifted')
  })

  it('checks every suspended representation before either credential mutation', () => {
    for (const source of [
      migration.indexOf('CREATE OR REPLACE FUNCTION public.register_webauthn'),
      migration.indexOf('CREATE OR REPLACE FUNCTION public.delete_webauthn'),
    ]) {
      const suspension = migration.indexOf('v_profile.banned_at IS NOT NULL', source)
      const mutation = Math.min(
        ...[
          migration.indexOf('INSERT INTO public.user_passkeys', source),
          migration.indexOf('DELETE FROM public.user_passkeys AS passkey', source),
        ].filter((position) => position > source)
      )

      expect(suspension).toBeGreaterThan(source)
      expect(mutation).toBeGreaterThan(suspension)
    }
    expect(migration).toContain('v_profile.deleted_at IS NOT NULL')
    expect(migration).toContain('v_profile.is_banned')
    expect(migration).toContain('v_profile.ban_expires_at > v_now')
  })

  it('persists only server-verified canonical credential values', () => {
    for (const value of [
      'p_user_id',
      'p_credential_id',
      'p_public_key',
      'p_counter',
      'p_transports',
      'p_device_name',
    ]) {
      expect(migration).toContain(value)
      expect(registrationRoute).toContain(value)
    }
    expect(registrationRoute).toContain('const { credential } = verification.registrationInfo')
    expect(registrationRoute).not.toMatch(/\.from\(['"]user_passkeys['"]\)/)
  })

  it('exposes both mutation functions to service_role only', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.register_webauthn_credential_for_active_profile_atomic\([\s\S]*?FROM PUBLIC, anon, authenticated, authenticator, service_role;[\s\S]*?GRANT EXECUTE ON FUNCTION public\.register_webauthn_credential_for_active_profile_atomic\([\s\S]*?TO service_role;/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.delete_webauthn_credential_for_active_profile_atomic\([\s\S]*?FROM PUBLIC, anon, authenticated, authenticator, service_role;[\s\S]*?GRANT EXECUTE ON FUNCTION public\.delete_webauthn_credential_for_active_profile_atomic\([\s\S]*?TO service_role;/
    )
    expect(migration).toContain('WebAuthn credential-mutation ACL drifted')
  })

  it('routes registration and deletion through exact typed acknowledgements', () => {
    expect(registrationRoute).toContain("'register_webauthn_credential_for_active_profile_atomic'")
    expect(registrationRoute).toContain("registration.status !== 'registered'")
    expect(credentialsRoute).toContain("'delete_webauthn_credential_for_active_profile_atomic'")
    expect(credentialsRoute).toContain("deletion.status !== 'deleted'")
    expect(credentialsRoute).not.toMatch(/\.from\(['"]user_passkeys['"]\)[\s\S]*?\.delete\(/)
  })
})
