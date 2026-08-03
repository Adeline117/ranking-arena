import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729186000_post_hashtag_count_integrity.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/post-hashtag-count-integrity.pg17.sh'),
  'utf8'
)
const triggerBody = migration.match(
  /CREATE OR REPLACE FUNCTION public\.maintain_post_hashtag_count\(\)[\s\S]*?\n\$function\$;/
)?.[0]
const recountBody = migration.match(
  /CREATE OR REPLACE FUNCTION public\.recount_hashtag_posts\(hashtag_ids uuid\[\]\)[\s\S]*?\n\$function\$;/
)?.[0]

describe('post hashtag count integrity migration', () => {
  it('is a bounded replayable transaction with a source-write fence', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.post_hashtags:post-count-integrity:migration'")
    expect(migration).toMatch(
      /LOCK TABLE public\.posts,[\s\S]*?public\.hashtags,[\s\S]*?public\.post_hashtags[\s\S]*?IN SHARE ROW EXCLUSIVE MODE/
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('requires canonical keys, cascading foreign keys, and the browser DML cutover', () => {
    expect(migration).toContain("constraint_row.conrelid = 'public.post_hashtags'::regclass")
    expect(migration).toContain("constraint_row.confrelid = 'public.posts'::regclass")
    expect(migration).toContain("constraint_row.confrelid = 'public.hashtags'::regclass")
    expect(migration).toContain("constraint_row.confdeltype = 'c'")
    expect(migration).toContain("constraint_row.contype = 'p'")
    expect(migration).toContain("constraint_row.contype IN ('p', 'u')")
    expect(migration).toContain('relation.relowner <> v_postgres_oid')
    expect(migration).toContain('browser post/hashtag DML closure must deploy first')
    expect(migration).toContain('pg_catalog.has_table_privilege')
    expect(migration).toContain('pg_catalog.has_column_privilege')
    expect(migration).toContain('post/hashtag DML remains exposed to PUBLIC')
  })

  it('repairs every cached count from associations before hardening its domain', () => {
    const repair = migration.match(
      /UPDATE public\.hashtags AS hashtag[\s\S]*?ALTER TABLE public\.hashtags\n  ALTER COLUMN post_count SET DEFAULT 0,[\s\S]*?ALTER COLUMN post_count SET NOT NULL;/
    )?.[0]

    expect(repair).toBeDefined()
    expect(repair).toContain('LEFT JOIN public.post_hashtags AS post_hashtag')
    expect(repair).toContain('pg_catalog.count(post_hashtag.post_id)::integer')
    expect(repair).toContain('hashtag.post_count IS DISTINCT FROM exact_count.post_count')
    expect(migration).toContain('CONSTRAINT hashtags_post_count_nonnegative')
    expect(migration).toContain('CHECK (post_count >= 0) NOT VALID')
    expect(migration).toContain('VALIDATE CONSTRAINT hashtags_post_count_nonnegative')
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+public\.hashtags\b/i)
  })

  it('maintains insert, delete, and move counts with locked arithmetic deltas', () => {
    expect(triggerBody).toBeDefined()
    expect(triggerBody).toMatch(/RETURNS trigger[\s\S]*SECURITY DEFINER/)
    expect(triggerBody).toContain('SET search_path = pg_catalog, pg_temp')
    expect(triggerBody).toContain('SET row_security = off')
    expect(triggerBody).toContain("TG_OP NOT IN ('INSERT', 'DELETE', 'UPDATE')")
    expect(triggerBody).toContain('ORDER BY hashtag.id')
    expect(triggerBody).toContain('FOR UPDATE')
    expect(triggerBody).toContain('SET post_count = hashtag.post_count - 1')
    expect(triggerBody).toContain('SET post_count = hashtag.post_count + 1')
    expect(triggerBody).not.toContain('SELECT pg_catalog.count')
    expect(triggerBody).not.toContain('GREATEST(')
    expect(triggerBody!.indexOf('ORDER BY hashtag.id')).toBeLessThan(
      triggerBody!.indexOf('SET post_count = hashtag.post_count - 1')
    )
    expect(migration).toMatch(
      /CREATE TRIGGER trg_post_hashtags_90_maintain_post_count\nAFTER INSERT OR DELETE OR UPDATE OF hashtag_id\nON public\.post_hashtags/
    )
  })

  it('keeps the trigger postgres-owned and unavailable for direct execution', () => {
    expect(migration).toContain(
      'ALTER FUNCTION public.maintain_post_hashtag_count() OWNER TO postgres'
    )
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES\n    ON FUNCTION public\.maintain_post_hashtag_count\(\)[\s\S]*?FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toContain('post-hashtag-count-integrity:v1:')
    expect(migration).toContain('DO $drop_count_trigger_aliases$')
    expect(migration).toContain('trigger_row.tgtype = 29')
    expect(migration).toContain('acl_entry.grantee <> v_postgres_oid')
  })

  it('serializes compatibility recounts before reading the source rows', () => {
    expect(recountBody).toBeDefined()
    expect(recountBody).toContain('ORDER BY hashtag.id')
    expect(recountBody).toContain('FOR UPDATE')
    expect(recountBody).toContain('SET post_count = (')
    expect(recountBody!.indexOf('FOR UPDATE')).toBeLessThan(
      recountBody!.indexOf('SET post_count = (')
    )
    expect(migration).toContain('recount-hashtag-posts:v3:')
    expect(migration).toMatch(
      /GRANT EXECUTE\n    ON FUNCTION public\.recount_hashtag_posts\(uuid\[\]\)\n    TO service_role/
    )
  })

  it('contains PostgreSQL 17 drift, concurrency, rollback, cascade, move, and replay proofs', () => {
    for (const marker of [
      'browser DML closure preflight rollback',
      'historical hashtag count drift repaired',
      'post count cache domain hardened',
      'trigger authority sealed',
      'concurrent same hashtag inserts retained',
      'locked recount retained concurrent delta',
      'duplicate association did not double count',
      'association rollback restored count',
      'batch association deltas retained',
      'post cascade decrement retained hashtag',
      'opposite association moves completed without deadlock',
      'migration replay repaired drift exactly once',
      'post hashtag count integrity PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
