import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729180000_atomic_bookmark_post_removal.sql'),
  'utf8'
)

describe('atomic bookmark post removal migration', () => {
  it('binds authority to the authenticated JWT and active account lifecycle', () => {
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'authenticated'")
    expect(migration).toContain('v_actor_id uuid := (SELECT auth.uid())')
    expect(migration).toContain("'account-recovery-admission:' || v_actor_id::text")
    expect(migration).toContain('profile.deleted_at IS NULL')
    expect(migration).toContain('profile.banned_at IS NULL')
    expect(migration).toContain('profile.is_banned IS TRUE')
  })

  it('serializes with toggles and binds the exact bookmark and folder identities', () => {
    expect(migration).toContain("'post-bookmark:' || p_post_id::text || ':' || v_actor_id::text")
    expect(migration).toMatch(
      /WHERE folder\.id = p_folder_id\s+AND folder\.user_id = v_actor_id[\s\S]*FOR SHARE/
    )
    expect(migration).toMatch(
      /WHERE bookmark\.user_id = v_actor_id\s+AND bookmark\.post_id = p_post_id\s+FOR UPDATE/
    )
    expect(migration).toContain('v_bookmark.id IS DISTINCT FROM p_bookmark_id')
    expect(migration).toContain('v_bookmark.folder_id IS NOT DISTINCT FROM p_folder_id')
    expect(migration).toContain("jsonb_build_object('status', 'conflict')")
  })

  it('is idempotent without any insert or toggle branch', () => {
    expect(migration).toContain("v_status := 'already_removed'")
    expect(migration).toContain('DELETE FROM public.post_bookmarks AS bookmark')
    expect(migration).not.toMatch(/INSERT INTO public\.post_bookmarks/)
    expect(migration).not.toContain('toggle_post_bookmark_atomic')
  })

  it('returns a complete acknowledgement and repairs the exact post counter', () => {
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
    expect(migration).toMatch(
      /count\(\*\)[\s\S]*WHERE bookmark\.post_id = p_post_id[\s\S]*UPDATE public\.posts AS post[\s\S]*WHERE post\.id = p_post_id/
    )
  })

  it('is executable only by authenticated users', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.remove_post_bookmark_from_folder_atomic\(uuid, uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.remove_post_bookmark_from_folder_atomic\(uuid, uuid, uuid\)[\s\S]*TO authenticated/
    )
  })
})
