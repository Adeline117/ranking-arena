import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

const migration = read('supabase/migrations/20260716179100_user_profile_read_audience.sql')
const serverHelpers = read('lib/supabase/server.ts')
const publicAudience = read('lib/profile/public-audience.ts')
const recoveryRoute = read('app/api/account/recover/route.ts')
const sensitiveProfileMigration = read(
  'supabase/migrations/20260612135859_restrict_user_profiles_pii_v2.sql'
)

describe('user profile read audience migration', () => {
  it('installs atomically under the shared profile-authority lock', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("'user-profile-authority-migrations'")
    expect(migration).toContain('LOCK TABLE public.user_profiles IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('fails closed on role, owner, auth helper and audience-column drift', () => {
    for (const role of ['postgres', 'anon', 'authenticated', 'service_role']) {
      expect(migration).toContain(`'${role}'`)
    }
    expect(migration).toContain('public.user_profiles must be an ordinary postgres-owned table')
    expect(migration).toContain('auth.uid() must exist and return uuid')
    expect(migration).toContain('public.user_profiles read-audience columns are incompatible')
  })

  it('removes every permissive SELECT path before installing one active-or-self policy', () => {
    expect(migration).toContain('DO $replace_profile_read_policies$')
    expect(migration).toContain("policy.polcmd IN ('r', '*')")
    expect(migration).toContain('CREATE POLICY user_profiles_active_or_self_read')
    expect(migration).toMatch(
      /CREATE POLICY user_profiles_active_or_self_read[\s\S]*?FOR SELECT[\s\S]*?TO anon, authenticated/
    )
    expect(migration).toMatch(
      /deleted_at IS NULL[\s\S]*?banned_at IS NULL[\s\S]*?COALESCE\(is_banned, false\)[\s\S]*?ban_expires_at IS NULL[\s\S]*?ban_expires_at > pg_catalog\.statement_timestamp\(\)/
    )
    expect(migration).toMatch(/CURRENT_USER = 'authenticated'[\s\S]*?id = \(SELECT auth\.uid\(\)\)/)
  })

  it('preserves service-role recovery and mutation authority without relying on bypassrls', () => {
    expect(migration).toMatch(
      /CREATE POLICY user_profiles_service_mutation[\s\S]*?FOR ALL[\s\S]*?TO service_role[\s\S]*?USING \(true\)[\s\S]*?WITH CHECK \(true\)/
    )
    expect(migration).toContain('service profile authority was not preserved')

    const statusHelper = serverHelpers.slice(
      serverHelpers.indexOf('export async function getUserAccountStatus'),
      serverHelpers.indexOf('async function getUserFromTokenWithProfilePolicy')
    )
    expect(statusHelper).toContain('getSupabaseAdmin()')
    expect(statusHelper).toContain(".select('banned_at, deleted_at')")
    expect(recoveryRoute).toContain('const admin = getSupabaseAdmin()')
    expect(recoveryRoute).toContain(".from('user_profiles')")
  })

  it('matches the existing public audience and own-sensitive-profile contracts', () => {
    expect(publicAudience).toMatch(/profile\.deleted_at !== null \|\| profile\.banned_at !== null/)
    expect(publicAudience).toContain('profile.is_banned !== true')
    expect(publicAudience).toContain('expiresAt <= now')

    expect(sensitiveProfileMigration).toContain(
      'CREATE OR REPLACE FUNCTION get_own_profile_sensitive()'
    )
    expect(sensitiveProfileMigration).toMatch(
      /get_own_profile_sensitive\(\)[\s\S]*?SECURITY DEFINER[\s\S]*?WHERE id = auth\.uid\(\)/
    )
    expect(sensitiveProfileMigration).toContain(
      'GRANT EXECUTE ON FUNCTION get_own_profile_sensitive() TO authenticated'
    )
  })

  it('postflight attests the exact two-policy SELECT authority', () => {
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('profile read policy set did not converge')
    expect(migration).toContain('active-or-self profile read policy is incompatible')
    expect(migration).toMatch(
      /policy\.polroles @> ARRAY\[v_anon, v_authenticated\]::oid\[\][\s\S]*?policy\.polroles <@ ARRAY\[v_anon, v_authenticated\]::oid\[\]/
    )
  })
})
