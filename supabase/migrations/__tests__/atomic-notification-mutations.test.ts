import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729173500_atomic_notification_mutations.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')
const pg17 = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/atomic-notification-mutations.pg17.sh'),
  'utf8'
)

describe('atomic notification mutation authority', () => {
  it('is transactional, replayable, and lifecycle-aware', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.notifications:atomic-mutations:migration'")
    expect(migration).toContain('DO $preflight$')
    expect(migration).toContain('DO $drop_direct_write_policies$')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain(
      'SELECT public.install_active_authenticated_subject_mutation_barriers()'
    )
    expect(migration).toContain(
      'SELECT public.assert_active_authenticated_subject_mutation_barriers()'
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('publishes one exact typed service-only RPC', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.mutate_notifications_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_action text,[\s\S]*p_notification_ids uuid\[\][\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.mutate_notifications_atomic\(uuid, text, uuid\[\]\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.mutate_notifications_atomic\(uuid, text, uuid\[\]\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('ambiguous atomic notification-mutation overload exists')
    expect(migration).toContain('atomic-notification-mutations:v1:')
    expect(databaseTypes).toContain('mutate_notifications_atomic: {')
    expect(databaseTypes).toContain('p_notification_ids: string[] | null')
  })

  it('quarantines direct writes and binds exact mutation sets', () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE[\s\S]*ON TABLE public\.notifications[\s\S]*FROM PUBLIC, anon, authenticated/
    )
    expect(migration).toContain("p_action NOT IN ('MARK_READ', 'MARK_ALL_READ', 'DELETE')")
    expect(migration).toContain("'account-recovery-admission:' || p_actor_id::text")
    expect(migration).toContain("'notification-mutation:' || p_actor_id::text")
    expect(migration).toContain('FOR UPDATE')
    expect(migration).toContain('v_owned_ids IS DISTINCT FROM v_requested_ids')
    expect(migration).toContain('GET DIAGNOSTICS v_changed_count = ROW_COUNT')
  })

  it('ships an isolated PostgreSQL 17 ACL, exact-set, and concurrency proof', () => {
    for (const marker of [
      'mixed own/foreign batch fails as one unit',
      'concurrent notification mutations were not serialized',
      'concurrent new notification crossed mark-all cutoff',
      'notification mutation bypassed lifecycle admission',
      'atomic notification mutations PostgreSQL 17 checks passed',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
