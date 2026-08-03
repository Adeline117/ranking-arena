import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729184000_close_post_direct_writes.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/close-post-direct-writes.pg17.sh'),
  'utf8'
)

describe('post direct-write closure migration', () => {
  it('is a replayable transactional postdeploy boundary', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("'public.posts:close-direct-writes:migration'")
    expect(migration).toContain(
      'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])'
    )
    expect(migration).toContain('public.set_post_pin_state_atomic(uuid,uuid,boolean)')
    expect(migration).toContain('trg_posts_10_content_version')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('revokes browser-wide UPDATE and retains only authenticated poll linking', () => {
    expect(migration).toMatch(
      /REVOKE UPDATE ON TABLE public\.posts[\s\S]*FROM PUBLIC, anon, authenticated, authenticator/
    )
    expect(migration).toContain("attribute.attname <> 'poll_id'")
    expect(migration).toContain(
      'REVOKE UPDATE (poll_id) ON TABLE public.posts\n  FROM PUBLIC, anon, authenticator'
    )
    expect(migration).toContain('GRANT UPDATE (poll_id) ON TABLE public.posts TO authenticated')
    expect(migration).toContain(
      "pg_catalog.has_column_privilege(\n       'authenticated', 'public.posts', 'poll_id', 'UPDATE'"
    )
  })

  it('independently guards author, changed columns, poll ownership, and immutability', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.guard_authenticated_post_update_boundary()'
    )
    expect(migration).toContain('OLD.author_id IS DISTINCT FROM v_actor_id')
    expect(migration).toContain("OLD.status IS DISTINCT FROM 'active'::public.post_status")
    expect(migration).toContain("pg_catalog.to_jsonb(NEW) - 'poll_id'")
    expect(migration).toContain('OLD.poll_id IS NOT NULL OR NEW.poll_id IS NULL')
    expect(migration).toContain('poll_row.post_id = OLD.id')
    expect(migration).toContain('CREATE TRIGGER trg_posts_05_authenticated_update_boundary')
    expect(migration).toContain('authenticated-post-update-boundary:v1:')
  })

  it('has PostgreSQL 17 replay, ACL, author, poll, and service-RPC proof', () => {
    for (const marker of [
      'migration replay',
      'authenticated content and pin updates revoked',
      'author-owned poll compatibility',
      'cross-author and cross-post poll isolation',
      'service atomic edit retained',
      'authenticated atomic RPC execution revoked',
      'post direct-write closure PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
