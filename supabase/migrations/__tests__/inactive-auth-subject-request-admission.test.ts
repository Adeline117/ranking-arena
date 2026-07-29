import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationName = '20260729156500_inactive_auth_subject_request_admission.sql'
const migrationsDirectory = resolve(process.cwd(), 'supabase/migrations')
const migration = readFileSync(resolve(migrationsDirectory, migrationName), 'utf8')
const pg17Proof = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/__tests__/inactive-auth-subject-request-admission.pg17.sh'
  ),
  'utf8'
)

describe('inactive authenticated-subject request admission', () => {
  it('refuses to replace an unknown PostgREST pre-request hook', () => {
    expect(migration).toContain('pg_catalog.pg_roles')
    expect(migration).toContain('pg_catalog.pg_db_role_setting')
    expect(migration).toContain("current_setting('pgrst.db_pre_request', true)")
    expect(migration).toContain("'public.enforce_active_authenticated_subject_pre_request'")
    expect(migration).toContain('refusing to replace existing PostgREST pre-request hook')
    expect(migration).toContain(
      "SET pgrst.db_pre_request =\n    'public.enforce_active_authenticated_subject_pre_request'"
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload config'")
  })

  it('derives the original request identity and fails authenticated ambiguity closed', () => {
    const helper = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.require_active_authenticated_subject_request'
      ),
      migration.indexOf('ALTER FUNCTION public.require_active_authenticated_subject_request')
    )
    expect(helper).toContain("current_setting('request.jwt.claims', true)")
    expect(helper).toContain("current_setting('request.jwt.claim.role', true)")
    expect(helper).toContain("current_setting('request.jwt.claim.sub', true)")
    expect(helper).toContain("current_setting('role', true)")
    expect(helper).toContain("v_claim_role IS DISTINCT FROM 'authenticated'")
    expect(helper).toContain('v_auth_uid := (SELECT auth.uid())')
    expect(helper).toContain('authenticated request JWT role claims conflict')
    expect(helper).toContain('authenticated request JWT subject claims conflict')
    expect(helper).toContain('authenticated request JWT identity is unavailable')
    expect(helper).not.toMatch(/\bcurrent_user\b(?! changes)/)
  })

  it('serializes reads with deletion, recovery, moderation, and hard deletion', () => {
    expect(migration).toContain('pg_advisory_xact_lock_shared')
    expect(migration).toContain("'account-recovery-admission:' || v_subject_id::text")
    expect(migration.indexOf('pg_advisory_xact_lock_shared')).toBeLessThan(
      migration.indexOf('FROM public.user_profiles AS profile')
    )
    expect(migration).toContain('v_profile.deleted_at IS NOT NULL')
    expect(migration).toContain('v_profile.banned_at IS NOT NULL')
    expect(migration).toContain('COALESCE(v_profile.is_banned, false)')
    expect(migration).toContain('authenticated account is not active')
  })

  it('guards table reads and pure-read RPCs before PostgREST execution', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.enforce_active_authenticated_subject_pre_request()'
    )
    expect(migration).toMatch(
      /enforce_active_authenticated_subject_pre_request\(\)[\s\S]*PERFORM public\.require_active_authenticated_subject_request\(\)/
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.enforce_active_authenticated_subject_pre_request()'
    )
    expect(pg17Proof).toContain('security_definer_private_record_count')
    expect(pg17Proof).toContain('deleted-security-definer-read')
    expect(pg17Proof).toContain('-U authenticator')
  })

  it('adds an authenticated restrictive policy to every enabled RLS parent and leaf', () => {
    expect(migration).toContain("namespace.nspname IN ('public', 'storage')")
    expect(migration).toContain("relation.relkind IN ('r', 'p')")
    expect(migration).toContain('AND relation.relrowsecurity')
    expect(migration).toContain('AS RESTRICTIVE FOR ALL ')
    expect(migration).toContain('TO authenticated ')
    expect(migration).toContain(
      'USING ((SELECT public.require_active_authenticated_subject_request()))'
    )
    expect(migration).toContain(
      'WITH CHECK ((SELECT public.require_active_authenticated_subject_request()))'
    )
    expect(migration).toContain('policy.polpermissive')
    expect(migration).toContain('policy.polroles = ARRAY[v_authenticated_oid]::oid[]')
    expect(migration).toContain('storage.objects must retain row level security')
  })

  it('converges the earlier mutation barrier for every future table or partition', () => {
    const installer = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.install_active_authenticated_subject_request_admission'
      ),
      migration.indexOf(
        'ALTER FUNCTION public.install_active_authenticated_subject_request_admission'
      )
    )
    const assertion = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.assert_active_authenticated_subject_request_admission'
      ),
      migration.indexOf(
        'ALTER FUNCTION public.assert_active_authenticated_subject_request_admission'
      )
    )
    expect(installer).toContain(
      'PERFORM public.install_active_authenticated_subject_mutation_barriers()'
    )
    expect(assertion).toContain(
      'PERFORM public.assert_active_authenticated_subject_mutation_barriers()'
    )
    expect(pg17Proof).toContain('future_partitioned_records_low')
    expect(pg17Proof).toContain('future request admission coverage is incomplete')
  })

  it('requires later relation and RLS migrations to converge and assert admission', () => {
    const migrationNames = readdirSync(migrationsDirectory)
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort()
    const barrierIndex = migrationNames.indexOf(migrationName)
    expect(barrierIndex).toBeGreaterThanOrEqual(0)

    const unguardedFutureMigrations = migrationNames.slice(barrierIndex + 1).filter((name) => {
      const source = readFileSync(resolve(migrationsDirectory, name), 'utf8')
      const changesProtectedRelations =
        /CREATE\s+(?:UNLOGGED\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public|storage)\s*\./i.test(
          source
        ) ||
        /\b(?:PARTITION\s+OF|ATTACH\s+PARTITION)\b/i.test(source) ||
        /ALTER\s+TABLE(?:\s+ONLY)?\s+(?:public|storage)\s*\.[\s\S]{0,160}?ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(
          source
        )
      if (!changesProtectedRelations) return false
      return (
        !source.includes('install_active_authenticated_subject_request_admission()') ||
        !source.includes('assert_active_authenticated_subject_request_admission()')
      )
    })

    expect(unguardedFutureMigrations).toEqual([])
  })

  it('carries PostgreSQL 17 identity, Storage, Realtime, and concurrency proofs', () => {
    expect(pg17Proof).toContain('foreign-pre-request-hook')
    expect(pg17Proof.match(/-f "\$REQUEST_MIGRATION"/g)).toHaveLength(3)
    expect(pg17Proof).toContain('storage.objects')
    expect(pg17Proof).toContain('realtime_private_events')
    expect(pg17Proof).toContain('read-wins-private')
    expect(pg17Proof).toContain('delete-wins-read-race')
    expect(pg17Proof).toContain('recovery-wins-private')
    expect(pg17Proof).toContain(
      'inactive authenticated-subject request admission pg17 proof passed'
    )
  })
})
