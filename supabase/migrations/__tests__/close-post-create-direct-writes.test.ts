import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729185000_close_post_create_direct_writes.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/close-post-create-direct-writes.pg17.sh'),
  'utf8'
)

describe('post create direct-write closure migration', () => {
  it('is an ordered, bounded, replayable postdeploy transaction', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.posts:close-create-direct-writes:migration'")
    expect(migration).toContain(
      'public.create_post_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[])'
    )
    expect(migration).toContain('public.guard_authenticated_post_update_boundary()')
    expect(migration).toContain('public.post_create_operation_results')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on historical duplicate, link, and poll-enabled drift', () => {
    const probe = migration.match(
      /DO \$historical_integrity_probe\$[\s\S]*?\$historical_integrity_probe\$;/
    )?.[0]

    expect(probe).toBeDefined()
    expect(probe).toContain('GROUP BY poll_row.post_id')
    expect(probe).toContain('HAVING pg_catalog.count(*) > 1')
    expect(probe).toContain('poll_row.post_id IS DISTINCT FROM post_row.id')
    expect(probe).toContain('post_row.poll_id IS DISTINCT FROM poll_row.id')
    expect(probe).toContain('post_row.poll_enabled IS DISTINCT FROM true')
    expect(probe).not.toMatch(/\b(UPDATE|DELETE)\s+public\.(posts|polls)\b/i)
  })

  it('adds one custom poll per post and deferred bidirectional checks', () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS polls_one_custom_per_post_idx[\s\S]*?ON public\.polls \(post_id\)[\s\S]*?WHERE post_id IS NOT NULL/
    )
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.enforce_post_poll_bidirectional_integrity()'
    )
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER trg_posts_90_poll_bidirectional_integrity'
    )
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER trg_polls_90_post_bidirectional_integrity'
    )
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(2)
    expect(migration).toContain('post-poll-bidirectional-integrity:v1:')
  })

  it('removes table and column DML from every browser-facing role', () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE[\s\S]*?ON TABLE public\.posts,[\s\S]*?public\.polls,[\s\S]*?public\.hashtags,[\s\S]*?public\.post_hashtags[\s\S]*?FROM PUBLIC, anon, authenticated, authenticator/
    )
    expect(migration).toContain('DO $revoke_browser_column_dml$')
    expect(migration).toContain("'REVOKE INSERT (%I), UPDATE (%I) ON TABLE %I.%I FROM %s'")
    expect(migration).toContain('attribute.attacl IS NOT NULL')
    expect(migration).toContain("acl_entry.privilege_type IN ('INSERT', 'UPDATE')")
    expect(migration).not.toMatch(/REVOKE\s+SELECT/i)
    expect(migration).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i)
    expect(migration).not.toMatch(/DROP\s+POLICY/i)
  })

  it('hardens recount and retains only service execution authorities', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.recount_hashtag_posts(hashtag_ids uuid[])'
    )
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('SET row_security = off')
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*?public\.recount_hashtag_posts\(uuid\[\]\)[\s\S]*?FROM PUBLIC, anon, authenticated, authenticator/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*?public\.recount_hashtag_posts\(uuid\[\]\)[\s\S]*?TO service_role/
    )
    expect(migration).toContain('recount-hashtag-posts:v2:')
    expect(migration).toContain('acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)')
  })

  it('contains PostgreSQL 17 replay, ACL, constraint, and rollback proofs', () => {
    for (const marker of [
      'duplicate migration rollback',
      'link drift migration rollback',
      'poll-enabled drift migration rollback',
      'migration replay',
      'browser post poll and hashtag DML revoked',
      'browser authorities revoked',
      'service atomic create retained',
      'service lost acknowledgement replay retained',
      'service cron direct writes retained',
      'select and RLS retained',
      'deferred wrong-link rejection',
      'deferred poll-side rejection',
      'deferred poll-enabled rejection',
      'legacy poll tri-state retained',
      'deferred delete and cascade compatibility',
      'post create closure PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
