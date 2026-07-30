import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729172000_atomic_notification_page.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')
const pg17 = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/atomic-notification-page.pg17.sh'),
  'utf8'
)

describe('atomic notification page authority', () => {
  it('is bounded, replayable, transactional, and lifecycle-aware', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.notifications:atomic-page:migration'")
    expect(migration).toContain('DO $preflight$')
    expect(migration).toContain('DO $data_preflight$')
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
      /CREATE OR REPLACE FUNCTION public\.get_notification_page_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_types text\[\],[\s\S]*p_before_created_at timestamptz,[\s\S]*p_before_id uuid,[\s\S]*p_limit integer[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.get_notification_page_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.get_notification_page_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('ambiguous atomic notification-page overload exists')
    expect(migration).toContain('atomic-notification-page:v1:')
    expect(databaseTypes).toContain('get_notification_page_atomic: {')
    expect(databaseTypes).toContain('p_types: string[] | null')
  })

  it('binds filter, page, unread count, actors, and cursor to one snapshot', () => {
    expect(migration).toContain("'account-recovery-admission:' || p_actor_id::text")
    expect(migration).toContain('exactly one MVCC snapshot')
    expect(migration).toContain('WITH integrity AS MATERIALIZED')
    expect(migration).toContain('candidates AS MATERIALIZED')
    expect(migration).toContain('page AS MATERIALIZED')
    expect(migration).toContain('unread AS MATERIALIZED')
    expect(migration).toContain('notification.type = ANY(v_types)')
    expect(migration).toContain('notification.id < p_before_id')
    expect(migration).toContain('LIMIT p_limit + 1')
    expect(migration).toContain('notifications_user_page_cursor_idx')
  })

  it('ships an isolated PostgreSQL 17 filter, cursor, ACL, and concurrency proof', () => {
    for (const marker of [
      'notification type filter leaked another type',
      'new notification shifted an issued cursor page',
      'uncommitted notification crossed the page snapshot',
      'uncommitted read crossed the unread snapshot',
      'notification actor lifecycle admission failed',
      'atomic notification page PostgreSQL 17 checks passed',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
