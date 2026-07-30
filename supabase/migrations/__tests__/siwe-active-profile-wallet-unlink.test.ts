import fs from 'node:fs'
import path from 'node:path'

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260729159500_siwe_active_profile_wallet_unlink.sql'
  ),
  'utf8'
)
const route = fs.readFileSync(path.join(process.cwd(), 'app/api/auth/siwe/unlink/route.ts'), 'utf8')

describe('SIWE active-profile wallet unlink', () => {
  it('uses the binding lifecycle and wallet identity lock namespaces', () => {
    expect(migration).toContain("'account-recovery-admission:' || p_user_id::text")
    expect(migration).toContain("'siwe-wallet-binding:' || v_observed_wallet")
    expect(migration).not.toContain("'siwe-wallet-unbinding:'")
    expect(migration).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*?FOR SHARE;[\s\S]*?FROM public\.user_profiles AS profile[\s\S]*?FOR UPDATE;/
    )
    expect(migration).toContain('SIWE wallet changed outside its lifecycle authority')
  })

  it('checks every suspension representation before clearing the wallet', () => {
    const suspensionCheck = migration.indexOf('v_profile.banned_at IS NOT NULL')
    const walletMutation = migration.indexOf('SET wallet_address = NULL')

    expect(suspensionCheck).toBeGreaterThan(0)
    expect(migration).toContain('v_profile.deleted_at IS NOT NULL')
    expect(migration).toContain('v_profile.is_banned')
    expect(migration).toContain('v_profile.ban_expires_at > v_now')
    expect(walletMutation).toBeGreaterThan(suspensionCheck)
    expect(migration).toContain("'already_unbound'::text")
    expect(migration).toContain("'unbound'::text")
  })

  it('is service-only, catalog-checked, replayable, and schema-reloaded', () => {
    expect(migration).toContain(
      "COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role'"
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*?unbind_siwe_wallet_for_active_profile_atomic\(uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*?unbind_siwe_wallet_for_active_profile_atomic\(uuid\)[\s\S]*?TO service_role/
    )
    expect(migration).toContain('existing SIWE wallet-unlink function is unfamiliar')
    expect(migration).toContain('SIWE wallet-binding prerequisite is incompatible')
    expect(migration).toContain('SIWE wallet-unlink relation ownership is incompatible')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('routes unlink only through the exact atomic acknowledgement', () => {
    expect(route).toContain("'unbind_siwe_wallet_for_active_profile_atomic'")
    expect(route).not.toMatch(/\.from\(['"]user_profiles['"]\)/)
    expect(route).not.toMatch(/\.update\(\{ wallet_address: null \}\)/)
    expect(route).toContain("acknowledgement?.status === 'suspended'")
    expect(route).toContain("acknowledgement?.status !== 'already_unbound'")
  })
})
