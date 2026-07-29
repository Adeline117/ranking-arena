import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationName = '20260729154500_inactive_auth_subject_mutation_barrier.sql'
const migrationsDirectory = resolve(process.cwd(), 'supabase/migrations')
const migration = readFileSync(resolve(migrationsDirectory, migrationName), 'utf8')
const runner = readFileSync(
  resolve(process.cwd(), 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/__tests__/inactive-auth-subject-mutation-barrier.pg17.sh'
  ),
  'utf8'
)

describe('inactive authenticated-subject mutation barrier', () => {
  it('derives the original request identity without trusting SECURITY DEFINER current_user', () => {
    expect(migration).toContain("current_setting('request.jwt.claims', true)")
    expect(migration).toContain("current_setting('request.jwt.claim.role', true)")
    expect(migration).toContain("current_setting('request.jwt.claim.sub', true)")
    expect(migration).toContain("current_setting('role', true)")
    expect(migration).toContain('v_auth_uid := (SELECT auth.uid())')
    expect(migration).toContain("v_claim_role IS DISTINCT FROM 'authenticated'")
    expect(migration).not.toMatch(/\bcurrent_user\b(?! changes)/)
  })

  it('serializes every authenticated statement with account lifecycle authority', () => {
    const guard = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.guard_active_authenticated_subject_mutation'
      ),
      migration.indexOf('ALTER FUNCTION public.guard_active_authenticated_subject_mutation')
    )
    expect(guard).toContain("TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')")
    expect(guard).toContain("TG_TABLE_SCHEMA NOT IN ('public', 'storage')")
    expect(guard).toContain("'account-recovery-admission:' || v_subject_id::text")
    expect(guard.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      guard.indexOf('FROM public.user_profiles AS profile')
    )
    expect(guard).toContain('v_profile.deleted_at IS NOT NULL')
    expect(guard).toContain('v_profile.banned_at IS NOT NULL')
    expect(guard).toContain('COALESCE(v_profile.is_banned, false)')
    expect(guard).toContain("TG_OP = 'TRUNCATE'")
  })

  it('covers public/storage partition parents and leaves before row triggers', () => {
    expect(migration).toContain("namespace.nspname IN ('public', 'storage')")
    expect(migration).toContain("relation.relkind IN ('r', 'p')")
    expect(migration).toContain('BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ')
    expect(migration).toContain('FOR EACH STATEMENT EXECUTE FUNCTION')
    expect(migration).toContain('trigger_row.tgtype = 62')
    expect(migration).toContain('earlier_trigger.tgname < v_guard_name')
    expect(migration).toContain(
      'REVOKE TRIGGER, TRUNCATE ON TABLE %I.%I FROM PUBLIC, authenticated'
    )
  })

  it('locks every profile creation, removal, deletion, recovery, and ban transition', () => {
    expect(migration).toContain('public.lock_account_lifecycle_subject_transition()')
    expect(migration).toContain('BEFORE INSERT OR DELETE ON public.user_profiles')
    expect(migration).toMatch(
      /BEFORE UPDATE OF '\s*\|\| 'deleted_at, banned_at, is_banned, ban_expires_at '/
    )
    expect(migration).toContain("'account-recovery-admission:' || v_subject_id::text")
    expect(migration).toContain('account lifecycle advisory-lock trigger coverage drifted')
  })

  it('keeps installation private and exposes only a read-only service coverage assertion', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.install_active_authenticated_subject_mutation_barriers\(\)[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.assert_active_authenticated_subject_mutation_barriers\(\)[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role;[\s\S]*GRANT EXECUTE ON FUNCTION public\.assert_active_authenticated_subject_mutation_barriers\(\)[\s\S]*TO service_role/
    )
    expect(migration).toContain(
      'SELECT public.install_active_authenticated_subject_mutation_barriers()'
    )
    expect(migration).toContain(
      'SELECT public.assert_active_authenticated_subject_mutation_barriers()'
    )
  })

  it('requires every later table or partition migration to install and assert coverage', () => {
    const migrationNames = readdirSync(migrationsDirectory)
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort()
    const barrierIndex = migrationNames.indexOf(migrationName)
    expect(barrierIndex).toBeGreaterThanOrEqual(0)

    const unguardedFutureMigrations = migrationNames.slice(barrierIndex + 1).filter((name) => {
      const source = readFileSync(resolve(migrationsDirectory, name), 'utf8')
      const createsProtectedRelation =
        /CREATE\s+(?:UNLOGGED\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public|storage)\s*\./i.test(
          source
        ) || /\b(?:PARTITION\s+OF|ATTACH\s+PARTITION)\b/i.test(source)
      if (!createsProtectedRelation) return false
      return (
        !source.includes('install_active_authenticated_subject_mutation_barriers()') ||
        !source.includes('assert_active_authenticated_subject_mutation_barriers()')
      )
    })

    expect(unguardedFutureMigrations).toEqual([])
  })

  it('ships last in ordered predeploy and carries a real PostgreSQL 17 concurrency proof', () => {
    const predeploy = runner.match(/PREDEPLOY_MIGRATIONS=\(([\s\S]*?)\n\)/)?.[1] ?? ''
    expect(predeploy).toContain(migrationName)
    expect(predeploy.indexOf(migrationName)).toBeGreaterThan(
      predeploy.indexOf('20260729075700_account_deletion_billing_intent.sql')
    )
    expect(pg17Proof).toContain('security_definer_insert')
    expect(pg17Proof).toContain('storage.objects')
    expect(pg17Proof).toContain('wait_for_subject_lock')
    expect(pg17Proof).toContain('inactive authenticated-subject mutation barrier pg17 proof passed')
  })
})
