import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260729175000_atomic_bookmark_folder_reads.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

function functionBody(name: string, nextMarker: string): string {
  return migration.slice(
    migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`),
    migration.indexOf(nextMarker)
  )
}

const owned = functionBody(
  'read_owned_bookmark_folders_snapshot',
  'ALTER FUNCTION public.read_owned_bookmark_folders_snapshot'
)
const subscribed = functionBody(
  'read_subscribed_bookmark_folders_snapshot',
  'ALTER FUNCTION public.read_subscribed_bookmark_folders_snapshot'
)
const profile = functionBody(
  'read_profile_bookmark_folders_snapshot',
  'ALTER FUNCTION public.read_profile_bookmark_folders_snapshot'
)
const detail = functionBody(
  'read_bookmark_folder_detail_snapshot',
  'ALTER FUNCTION public.read_bookmark_folder_detail_snapshot'
)

describe('atomic bookmark folder read snapshots migration', () => {
  it('keeps every public read authority service-only and stable', () => {
    for (const body of [owned, subscribed, profile, detail]) {
      expect(body).toContain('STABLE')
      expect(body).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
      expect(body).toContain('SET row_security = off')
    }

    for (const signature of [
      'read_owned_bookmark_folders_snapshot(uuid)',
      'read_subscribed_bookmark_folders_snapshot(\n  uuid,\n  integer,\n  integer\n)',
      'read_profile_bookmark_folders_snapshot(\n  uuid,\n  uuid,\n  boolean\n)',
      'read_bookmark_folder_detail_snapshot(\n  uuid,\n  uuid,\n  integer,\n  integer\n)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature}`)
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature}`)
    }
    expect(migration).not.toMatch(/GRANT EXECUTE[\s\S]*TO (anon|authenticated)/)
  })

  it('derives folder counts from current visible bookmarks instead of the stale column', () => {
    const counter = functionBody(
      'read_bookmark_folder_visible_post_count',
      'ALTER FUNCTION public.read_bookmark_folder_visible_post_count'
    )
    expect(counter).toContain('FROM public.post_bookmarks AS bookmark')
    expect(counter).toContain('public.can_actor_read_post_id(bookmark.post_id, p_actor_id)')
    expect(counter).toContain('p_is_default IS TRUE AND bookmark.folder_id IS NULL')
    expect(migration).not.toContain("'post_count', folder.post_count")
  })

  it('filters current subscription privacy and owner lifecycle before pagination', () => {
    expect(subscribed).toContain('folder.is_public IS TRUE')
    expect(subscribed).toContain('public.bookmark_folder_profile_is_active(folder.user_id)')
    expect(subscribed).toMatch(
      /WHERE subscription\.user_id = p_actor_id[\s\S]*ORDER BY subscription\.created_at DESC[\s\S]*LIMIT p_limit \+ 1/
    )
    expect(subscribed).toContain("'has_more', COALESCE(v_has_more, false)")
  })

  it('never lets a forged profile flag expose another account private folders', () => {
    expect(profile).toContain('(p_include_private AND p_actor_id IS DISTINCT FROM p_profile_id)')
    expect(profile).toContain('(p_include_private OR folder.is_public IS TRUE)')
    expect(profile).toContain('public.bookmark_folder_profile_is_active(p_profile_id)')
  })

  it('applies canonical post audience before detail offset and lookahead', () => {
    const audienceIndex = detail.indexOf('public.can_actor_read_post_id(post.id, p_actor_id)')
    const offsetIndex = detail.indexOf('OFFSET p_offset')
    expect(audienceIndex).toBeGreaterThan(0)
    expect(offsetIndex).toBeGreaterThan(audienceIndex)
    expect(detail).toContain('visible_bookmarks AS MATERIALIZED')
    expect(detail).toContain('LIMIT p_limit + 1')
    expect(detail).toContain("'post_count', v_post_count")
  })

  it('binds private detail, subscription state, and owner state to one snapshot', () => {
    expect(detail).toContain('public.bookmark_folder_profile_is_active(folder.user_id)')
    expect(detail).toContain('IF NOT v_folder.is_public AND NOT v_is_owner THEN')
    expect(detail).toContain("'folder_forbidden'")
    expect(detail).toContain('subscription.user_id = p_actor_id')
    expect(detail).toContain("'is_subscribed', v_is_subscribed")
    expect(detail).toContain("'subscriber_count', v_subscriber_count")
  })
})
