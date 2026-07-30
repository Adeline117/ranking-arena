import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729175500_atomic_ranking_notification_batch.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')
const pg17 = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/atomic-ranking-notification-batch.pg17.sh'),
  'utf8'
)

describe('atomic ranking-notification batch authority', () => {
  it('is transactional, replayable, and lifecycle-aware', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.notifications:atomic-ranking-batch:migration'")
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
      /CREATE OR REPLACE FUNCTION public\.create_ranking_notifications_batch_atomic\([\s\S]*p_rows jsonb[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.create_ranking_notifications_batch_atomic\(jsonb\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.create_ranking_notifications_batch_atomic\(jsonb\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('ambiguous atomic ranking-notification batch overload exists')
    expect(migration).toContain('atomic-ranking-notification-batch:v1:')
    expect(databaseTypes).toContain('create_ranking_notifications_batch_atomic: {')
    expect(databaseTypes).toContain('Args: { p_rows: Json }')
  })

  it('enforces immutable retry identity and an exact result partition', () => {
    expect(migration).toContain('notifications_ranking_change_identity_unique')
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS')
    expect(migration).toContain('PARTITION BY')
    expect(migration).toContain("notification.type = 'ranking_change'")
    expect(migration).toContain("'account-recovery-admission:' || v_recipient_id::text")
    expect(migration).toContain("'notification-create:' || pg_catalog.jsonb_build_array(")
    expect(migration).toContain("'reason', 'IDENTITY_CONFLICT'")
    expect(migration).toContain("'outcome', CASE")
    expect(migration).toContain("THEN 'RECIPIENT_UNAVAILABLE'")
    expect(migration).toContain("THEN 'CREATED'")
    expect(migration).toContain("ELSE 'DEDUPLICATED'")
    expect(migration).toContain("'requested_count', v_requested_count")
    expect(migration).toContain("'created_count', v_created_count")
    expect(migration).toContain("'deduplicated_count', v_deduplicated_count")
    expect(migration).toContain("'skipped_count', v_skipped_count")
  })

  it('ships isolated PostgreSQL 17 ACL, replay, partial-batch, and concurrency proofs', () => {
    for (const marker of [
      'Legacy retries left two copies',
      'Partial-chunk recovery',
      'concurrent ranking notification batches were not deduplicated',
      'ranking notification batch bypassed lifecycle admission',
      'atomic ranking notification batch PostgreSQL 17 checks passed',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
