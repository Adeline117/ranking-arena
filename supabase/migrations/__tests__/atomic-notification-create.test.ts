import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729174500_atomic_notification_create.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')
const pg17 = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/atomic-notification-create.pg17.sh'),
  'utf8'
)

describe('atomic notification creation authority', () => {
  it('is transactional, replayable, and lifecycle-aware', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.notifications:atomic-create:migration'")
    expect(migration).toContain('DO $preflight$')
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
      /CREATE OR REPLACE FUNCTION public\.create_notification_atomic\([\s\S]*p_recipient_id uuid,[\s\S]*p_type text,[\s\S]*p_title text,[\s\S]*p_message text,[\s\S]*p_link text,[\s\S]*p_actor_id uuid,[\s\S]*p_reference_id text,[\s\S]*p_deduplicate boolean,[\s\S]*p_dedup_window_seconds integer[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.create_notification_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.create_notification_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('ambiguous atomic notification-create overload exists')
    expect(migration).toContain('atomic-notification-create:v1:')
    expect(databaseTypes).toContain('create_notification_atomic: {')
    expect(databaseTypes).toContain('p_dedup_window_seconds: number')
  })

  it('binds lifecycle, request payload, and dedup identity', () => {
    expect(migration).toContain("'account-recovery-admission:' || v_subject_id::text")
    expect(migration).toContain("'notification-create:' || pg_catalog.jsonb_build_array(")
    expect(migration).toContain('notification.actor_id IS NOT DISTINCT FROM p_actor_id')
    expect(migration).toContain('notification.reference_id = p_reference_id')
    expect(migration).toContain('FOR UPDATE')
    expect(migration).toContain("'outcome', 'CREATED'")
    expect(migration).toContain("'outcome', 'DEDUPLICATED'")
    expect(migration).toContain("'outcome', 'SKIPPED_SELF'")
    expect(migration).toContain('notifications_atomic_create_dedup_idx')
  })

  it('ships an isolated PostgreSQL 17 ACL, NULL-actor, and concurrency proof', () => {
    for (const marker of [
      'incorrectly skipped dedup whenever actor_id was absent',
      'concurrent notification creates were not deduplicated',
      'reciprocal notification lifecycle locks deadlocked',
      'notification create bypassed lifecycle admission',
      'atomic notification create PostgreSQL 17 checks passed',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
