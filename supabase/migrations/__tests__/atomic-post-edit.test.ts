import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729183500_atomic_post_edit.sql'),
  'utf8'
)
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')
const pg17Proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/atomic-post-edit.pg17.sh'),
  'utf8'
)

describe('atomic post edit migration', () => {
  it('is bounded, replayable, transactional, and reloads PostgREST', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.posts:atomic-post-edit:migration'")
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('publishes one generated service-only mutation authority', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.edit_post_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_post_id uuid,[\s\S]*p_expected_version bigint,[\s\S]*p_title text,[\s\S]*p_content text,[\s\S]*p_update_images boolean,[\s\S]*p_images text\[\][\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.edit_post_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.edit_post_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-post-edit:v1:')
    expect(databaseTypes).toContain('edit_post_atomic: {')
    expect(databaseTypes).toContain('p_expected_version: number')
    expect(databaseTypes).toContain('content_version: number')
  })

  it('locks before comparing the rendered revision and updating exactly one row', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.edit_post_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const rowLock = body!.indexOf(
      'FROM public.posts AS target\n  WHERE target.id = p_post_id\n  FOR UPDATE'
    )
    const revisionCheck = body!.indexOf(
      'v_post.content_version IS DISTINCT FROM p_expected_version'
    )
    const update = body!.indexOf('UPDATE public.posts AS target')
    const rowCount = body!.indexOf('v_update_count <> 1')

    expect(rowLock).toBeGreaterThan(0)
    expect(rowLock).toBeLessThan(revisionCheck)
    expect(revisionCheck).toBeLessThan(update)
    expect(update).toBeLessThan(rowCount)
    expect(body).toContain('target.content_version = p_expected_version')
    expect(body).toContain("jsonb_build_object('status', 'conflict')")
    expect(body).toContain("'status', 'updated'")
    expect(body).toContain("'status', 'unchanged'")
  })

  it('owns monotonically increasing content revisions in a database trigger', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS content_version bigint')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.advance_post_content_version()')
    expect(migration).toContain('CREATE TRIGGER trg_posts_10_content_version')
    expect(migration).toContain('NEW.content_version := OLD.content_version + 1')
    expect(migration).toContain('NEW.content_version := OLD.content_version')
    expect(migration).toContain("NEW.updated_at := OLD.updated_at + '1 microsecond'::interval")
  })

  it('validates active ownership, bounded content, and exact image intent', () => {
    expect(migration).toContain("jsonb_build_object('status', 'account_inactive')")
    expect(migration).toContain("jsonb_build_object('status', 'forbidden')")
    expect(migration).toContain("jsonb_build_object('status', 'not_found')")
    expect(migration).toContain('pg_catalog.length(p_title) NOT BETWEEN 1 AND 200')
    expect(migration).toContain('pg_catalog.length(p_content) > 50000')
    expect(migration).toContain('pg_catalog.cardinality(p_images) > 9')
    expect(migration).toContain("image_url !~* '^https?://[^[:space:][:cntrl:]]+$'")
    expect(migration).toContain('v_updated_post.images IS DISTINCT FROM')
  })

  it('has a PostgreSQL 17 replay, conflict, concurrency, and ACL proof', () => {
    for (const marker of [
      'migration replay',
      'stale revision conflict',
      'concurrent edit compare-and-swap',
      'author and lifecycle isolation',
      'authenticated RPC execution revoked',
      'atomic post edit PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
