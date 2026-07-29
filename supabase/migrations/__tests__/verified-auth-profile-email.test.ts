import fs from 'node:fs'
import path from 'node:path'

const migrationName = '20260729075400_verified_auth_profile_email.sql'
const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations', migrationName),
  'utf8'
)

describe('verified Auth profile email authority migration', () => {
  it('backfills every profile email from the Auth identity under the shared lock order', () => {
    expect(migration).toContain(
      "pg_catalog.hashtextextended('user-profile-authority-migrations', 0)"
    )
    expect(migration).toMatch(
      /LOCK TABLE auth\.users, public\.user_profiles IN SHARE ROW EXCLUSIVE MODE/
    )
    expect(migration).toMatch(
      /UPDATE public\.user_profiles AS profile[\s\S]*SET email = auth_user\.email::text[\s\S]*FROM auth\.users AS auth_user[\s\S]*profile\.email IS DISTINCT FROM auth_user\.email::text/
    )
    expect(migration).toContain('persisted profile emails were not converged')
  })

  it('serializes against Auth email changes before writing the projection', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.admit_verified_auth_profile_atomic('
    )
    const authLock = migration.indexOf(
      'FROM auth.users AS auth_user',
      migration.indexOf('AS $function$')
    )
    const profileLock = migration.indexOf(
      'FROM public.user_profiles AS profile',
      migration.indexOf('AS $function$')
    )
    const profileWrite = migration.indexOf(
      'UPDATE public.user_profiles AS profile',
      migration.indexOf('AS $function$')
    )
    expect(authLock).toBeGreaterThan(-1)
    expect(profileLock).toBeGreaterThan(authLock)
    expect(profileWrite).toBeGreaterThan(profileLock)
    expect(migration.slice(authLock, profileLock)).toContain('FOR UPDATE')
    expect(migration).toContain('v_auth_email IS DISTINCT FROM p_verified_email')
    expect(migration).toContain("RETURN 'unavailable'")
    expect(migration).toContain("RETURN 'missing'")
    expect(migration).toContain("RETURN 'suspended'")
    expect(migration).toContain("RETURN 'active'")
  })

  it('keeps the admission function private to the service role and attests its source', () => {
    expect(migration).toMatch(
      /ALTER FUNCTION public\.admit_verified_auth_profile_atomic\(uuid, text\)[\s\S]*OWNER TO postgres/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.admit_verified_auth_profile_atomic\(uuid, text\)[\s\S]*FROM PUBLIC, anon, authenticated/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.admit_verified_auth_profile_atomic\(uuid, text\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('verified profile admission source drifted')
    expect(migration).toContain('verified profile admission ACL drifted')
    expect(migration).toContain('verified profile admission overload count drifted')
  })
})
