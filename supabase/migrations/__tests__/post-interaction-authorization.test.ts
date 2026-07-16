import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260715224000_post_interaction_authorization.sql'),
  'utf8'
)

describe('canonical post interaction authorization migration', () => {
  it('keeps explicit actor field decisions private', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.can_actor_read_post_fields/)
    expect(migration).toMatch(/profile\.banned_at IS NULL/)
    expect(migration).toMatch(/profile\.deleted_at IS NULL/)
    expect(migration).toMatch(/FROM public\.blocked_users/)
    expect(migration).toMatch(/FROM public\.group_bans/)
    expect(migration).toMatch(/FROM public\.group_members/)
    expect(migration).toMatch(/FROM public\.user_follows/)
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.can_actor_read_post_fields[\s\S]*service_role/
    )
  })

  it('lets only service routes resolve a post id for an explicit actor', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.can_service_actor_read_post/)
    expect(migration).toMatch(/auth\.role\(\)[\s\S]*IS DISTINCT FROM 'service_role'/)
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.can_service_actor_read_post\(uuid, uuid\)[\s\S]*service_role/
    )
    expect(migration).toMatch(/wrapper\.original_post_id[\s\S]*root\.original_post_id IS NULL/)
  })

  it('binds repost wrappers to their current root at the posts policy', () => {
    expect(migration).toMatch(/CREATE POLICY posts_repost_root_read_contract/)
    expect(migration).toMatch(/AS RESTRICTIVE/)
    expect(migration).toMatch(/can_current_user_read_repost_root\(original_post_id\)/)
  })

  it('locks every mutable authorization fact for child writes', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.lock_actor_can_interact_with_post/
    )
    expect(migration).toMatch(/FROM public\.user_profiles AS actor_profile[\s\S]*FOR SHARE/)
    expect(migration).toMatch(/FROM public\.posts AS wrapper[\s\S]*FOR SHARE/)
    expect(migration).toMatch(/FROM public\.posts AS root[\s\S]*FOR SHARE/)
    expect(migration).toMatch(/FROM public\.groups AS locked_group[\s\S]*FOR UPDATE/)
    expect(migration).toMatch(/FROM public\.group_members AS locked_member[\s\S]*FOR SHARE/)
    expect(migration).toMatch(/FROM public\.group_bans AS locked_ban[\s\S]*FOR SHARE/)
    expect(migration).toMatch(/FROM public\.user_follows AS locked_follow[\s\S]*FOR SHARE/)
    expect(migration).toMatch(/pg_advisory_xact_lock/)
  })

  it('serializes absent block edges with the same viewer-author lock', () => {
    expect(migration).toMatch(/CREATE TRIGGER trg_serialize_post_audience_block_edge/)
    expect(migration).toMatch(/BEFORE INSERT OR DELETE OR UPDATE/)
    expect(migration).toMatch(/'post-audience:block:' \|\| LEAST/)
  })
})
