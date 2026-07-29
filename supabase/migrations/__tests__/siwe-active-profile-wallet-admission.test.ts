import fs from 'node:fs'
import path from 'node:path'

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260729158500_siwe_active_profile_wallet_admission.sql'
  ),
  'utf8'
)
const route = fs.readFileSync(path.join(process.cwd(), 'app/api/auth/siwe/verify/route.ts'), 'utf8')

describe('SIWE active-profile wallet admission', () => {
  it('serializes wallet binding with account lifecycle transitions', () => {
    expect(migration).toContain("'account-recovery-admission:' || p_user_id::text")
    expect(migration).toContain("'siwe-wallet-binding:' || p_wallet_address")
    expect(migration).toMatch(
      /FOR SHARE;[\s\S]*?FROM public\.user_profiles AS profile[\s\S]*?FOR UPDATE;/
    )
    expect(migration).toMatch(
      /v_profile\.banned_at IS NOT NULL[\s\S]*?v_profile\.deleted_at IS NOT NULL[\s\S]*?v_profile\.is_banned[\s\S]*?v_profile\.ban_expires_at > v_now/
    )
    expect(migration).toMatch(
      /RETURN QUERY SELECT[\s\S]*?'suspended'::text[\s\S]*?SET wallet_address = p_wallet_address/
    )
  })

  it('keeps both authorities service-only and fails closed on catalog drift', () => {
    expect(migration).toContain(
      "COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role'"
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*?bind_siwe_wallet_for_active_profile_atomic\(uuid, text\)[\s\S]*?FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*?bind_siwe_wallet_for_active_profile_atomic\(uuid, text\)[\s\S]*?TO service_role/
    )
    expect(migration).toContain('canonical wallet identity index is missing or incompatible')
    expect(migration).toContain('SIWE lifecycle authority ACL drifted')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('checks suspension before any rejected-account profile projection mutation', () => {
    const suspension = migration.indexOf("RETURN 'suspended'")
    const emailMutation = migration.indexOf('SET email = v_auth_email')

    expect(suspension).toBeGreaterThan(0)
    expect(emailMutation).toBeGreaterThan(suspension)
  })

  it('uses atomic binding plus pre-mint and pre-release database admission', () => {
    expect(route).toContain("'bind_siwe_wallet_for_active_profile_atomic'")
    expect(route).not.toMatch(/\.update\(\{ wallet_address: walletAddress \}\)/)
    expect(route).toMatch(
      /requireActiveProfileAdmission\(profile\.id, email\)[\s\S]*?requireVerificationToken[\s\S]*?requireActiveProfileAdmission\(profile\.id, email\)/
    )
    expect(route).toContain("status === 'suspended'")
  })
})
