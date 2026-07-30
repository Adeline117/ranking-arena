import fs from 'node:fs'
import path from 'node:path'

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260729160500_webauthn_active_profile_assertion.sql'
  ),
  'utf8'
)
const route = fs.readFileSync(
  path.join(process.cwd(), 'app/api/auth/webauthn/authentication-verify/route.ts'),
  'utf8'
)

describe('WebAuthn active-profile assertion authority', () => {
  it('locks lifecycle, Auth, profile, then credential in one global order', () => {
    expect(migration).toContain("'account-recovery-admission:' || p_user_id::text")
    expect(migration).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*?FOR SHARE;[\s\S]*?FROM public\.user_profiles AS profile[\s\S]*?FOR UPDATE;[\s\S]*?FROM public\.user_passkeys AS passkey[\s\S]*?FOR UPDATE;/
    )
    expect(migration).toContain('WebAuthn authentication source drifted')
  })

  it('rejects every suspended representation before consuming the assertion', () => {
    const suspension = migration.indexOf('v_profile.banned_at IS NOT NULL')
    const counterMutation = migration.indexOf('SET counter = p_new_counter')

    expect(suspension).toBeGreaterThan(0)
    expect(migration).toContain('v_profile.deleted_at IS NOT NULL')
    expect(migration).toContain('v_profile.is_banned')
    expect(migration).toContain('v_profile.ban_expires_at > v_now')
    expect(counterMutation).toBeGreaterThan(suspension)
  })

  it('binds every verified credential field and a counterless CAS generation', () => {
    for (const field of [
      'passkey.id = p_passkey_id',
      'passkey.user_id = p_user_id',
      'passkey.credential_id = p_credential_id',
      'passkey.public_key = p_expected_public_key',
      'passkey.counter = p_expected_counter',
      'passkey.last_used_at IS NOT DISTINCT FROM p_expected_last_used_at',
    ]) {
      expect(migration).toContain(field)
    }
    expect(migration).toContain("interval '1 microsecond'")
    expect(migration).toContain('p_expected_counter > 0')
    expect(migration).toContain('p_new_counter <= p_expected_counter')
  })

  it('removes all browser credential mutation authority', () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER[\s\S]*?ON TABLE public\.user_passkeys[\s\S]*?FROM PUBLIC, anon, authenticated, authenticator/
    )
    expect(migration).toContain('WebAuthn credential table authority drifted')
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.consume_webauthn_authentication_atomic\([\s\S]*?\) TO service_role/
    )
  })

  it('routes one exact consumption before mint and rechecks before mint/release', () => {
    expect(route).toContain("'consume_webauthn_authentication_atomic'")
    expect(route).not.toMatch(/\.from\(['"]user_profiles['"]\)/)
    expect(route).not.toMatch(/\.from\(['"]user_passkeys['"]\)[\s\S]*?\.update\(/)
    expect(route).toMatch(
      /hasActiveVerifiedAuthProfile[\s\S]*?generateLink[\s\S]*?hasActiveVerifiedAuthProfile[\s\S]*?verifyOtp[\s\S]*?hasActiveVerifiedAuthProfile/
    )
    expect(route).toContain('p_expected_public_key: row.public_key')
    expect(route).toContain('p_expected_last_used_at: row.last_used_at')
  })
})
