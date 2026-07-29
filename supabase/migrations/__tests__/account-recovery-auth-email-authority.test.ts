import fs from 'node:fs'
import path from 'node:path'

const migrationName = '20260729075500_account_recovery_auth_email_authority.sql'
const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations', migrationName),
  'utf8'
)

describe('account recovery Auth email authority migration', () => {
  it('resolves only the canonical Auth identity and fails ambiguous matches closed', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.resolve_account_recovery_auth_subject('
    )
    expect(migration).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*pg_catalog\.lower\(pg_catalog\.btrim\(auth_user\.email::text\)\)[\s\S]*LIMIT 2/
    )
    expect(migration).toContain('IF v_match_count <> 1 THEN')
    expect(migration).toContain('RETURN NULL')
    expect(migration).not.toMatch(
      /FROM public\.user_profiles AS profile[\s\S]*WHERE[\s\S]*profile\.email/
    )
  })

  it('keeps the resolver service-only and attests its exact source', () => {
    expect(migration).toMatch(
      /ALTER FUNCTION public\.resolve_account_recovery_auth_subject\(text\)[\s\S]*OWNER TO postgres/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.resolve_account_recovery_auth_subject\(text\)[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.resolve_account_recovery_auth_subject\(text\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('recovery Auth subject resolver source drifted')
    expect(migration).toContain('recovery Auth subject resolver ACL drifted')
    expect(migration).toContain('recovery Auth subject resolver overload count drifted')
  })
})
