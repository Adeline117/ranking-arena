import fs from 'node:fs'
import path from 'node:path'

const migrationName = '20260729075600_verified_auth_profile_ban_authority.sql'
const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations', migrationName),
  'utf8'
)

describe('verified Auth profile ban authority migration', () => {
  it('replaces the admission gate with every active suspension representation', () => {
    expect(migration).toContain(
      "'public.admit_verified_auth_profile_atomic(uuid,text)'::pg_catalog.regprocedure"
    )
    expect(migration).toMatch(
      /SELECT[\s\S]*profile\.banned_at,[\s\S]*profile\.ban_expires_at,[\s\S]*profile\.deleted_at,[\s\S]*profile\.is_banned[\s\S]*FOR UPDATE/
    )
    expect(migration).toMatch(
      /v_banned_at IS NOT NULL[\s\S]*v_deleted_at IS NOT NULL[\s\S]*COALESCE\(v_is_banned, false\)[\s\S]*v_ban_expires_at IS NULL[\s\S]*v_ban_expires_at > pg_catalog\.clock_timestamp\(\)/
    )
    expect(migration).toContain("RETURN 'suspended'")
    expect(migration).toContain("RETURN 'active'")
  })

  it('preserves exact Auth-email binding and service-only execution', () => {
    expect(migration).toContain('v_auth_email IS DISTINCT FROM p_verified_email')
    expect(migration).toContain('UPDATE public.user_profiles AS profile')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.admit_verified_auth_profile_atomic\(uuid, text\)[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.admit_verified_auth_profile_atomic\(uuid, text\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('verified profile ban admission source drifted')
    expect(migration).toContain('verified profile ban admission ACL drifted')
  })
})
