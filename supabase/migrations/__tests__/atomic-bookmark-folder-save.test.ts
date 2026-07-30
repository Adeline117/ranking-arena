import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729181000_atomic_bookmark_folder_save.sql'),
  'utf8'
)

describe('atomic bookmark folder save migration', () => {
  it('uses authenticated identity and current post audience authority', () => {
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'authenticated'")
    expect(migration).toContain('v_actor_id uuid := (SELECT auth.uid())')
    expect(migration).toContain("'account-recovery-admission:' || v_actor_id::text")
    expect(migration).toContain('public.lock_actor_can_interact_with_post(p_post_id, v_actor_id)')
  })

  it('serializes with toggle/removal and rejects cross-owner folders', () => {
    expect(migration).toContain("'post-bookmark:' || p_post_id::text || ':' || v_actor_id::text")
    expect(migration).toMatch(
      /WHERE folder\.id = p_folder_id\s+AND folder\.user_id = v_actor_id\s+FOR SHARE/
    )
    expect(migration).toContain("jsonb_build_object('status', 'folder_not_found')")
  })

  it('implements add, move, and idempotent same-folder save without delete', () => {
    expect(migration).toContain("v_status := 'added'")
    expect(migration).toContain("v_status := 'moved'")
    expect(migration).toContain("v_status := 'already_saved'")
    expect(migration).toContain('v_existing_folder_id IS NOT DISTINCT FROM p_folder_id')
    expect(migration).toContain('v_folder.is_default AND v_existing_folder_id IS NULL')
    expect(migration).not.toMatch(/DELETE FROM public\.post_bookmarks/)
  })

  it('returns identity-bound bookmarked truth and an exact count', () => {
    for (const field of [
      'status',
      'user_id',
      'post_id',
      'bookmark_id',
      'folder_id',
      'bookmarked',
      'bookmark_count',
    ]) {
      expect(migration).toContain(`'${field}'`)
    }
    expect(migration).toContain("'bookmarked', true")
    expect(migration).toMatch(
      /count\(\*\)[\s\S]*WHERE bookmark\.post_id = p_post_id[\s\S]*UPDATE public\.posts AS post/
    )
  })

  it('is executable only by authenticated users', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.save_post_bookmark_to_folder_atomic\(uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.save_post_bookmark_to_folder_atomic\(uuid, uuid\)[\s\S]*TO authenticated/
    )
  })
})
