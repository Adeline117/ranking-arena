import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716191000_atomic_user_block.sql'),
  'utf8'
)
const route = readFileSync(join(process.cwd(), 'app/api/users/[handle]/block/route.ts'), 'utf8')

describe('atomic user block boundary', () => {
  it('is a bounded transactional second-stage expand migration', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('DO $preflight$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('public.mutate_user_follow_atomic(uuid,uuid,text)')
    expect(migration).toContain('20260716192000')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('depends on active profile state and the exact shared pair serializer', () => {
    for (const relation of [
      'auth.users',
      'public.user_profiles',
      'public.user_follows',
      'public.blocked_users',
    ]) {
      expect(migration).toContain(relation)
    }
    expect(migration).toContain('public.serialize_direct_message_pair_edge()')
    expect(migration).toContain('trg_serialize_dm_block_pair')
    expect(migration).toContain('trg_serialize_dm_follow_pair')
    expect(migration).toContain("'direct-message:pair:' || v_pair")
    expect(migration).toContain('trigger_row.tgtype = 31')
    expect(migration).toContain('pg_catalog.pg_inherits')
  })

  it('publishes one service-only block/unblock RPC', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.mutate_user_block_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_target_id uuid,[\s\S]*p_action text[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role(), ''), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.mutate_user_block_atomic(uuid, uuid, text)'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.mutate_user_block_atomic(uuid, uuid, text)'
    )
    expect(migration).toContain('atomic user block EXECUTE boundary drifted')
  })

  it('uses Auth, pair, and profile locks before any edge mutation', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.mutate_user_block_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const authLock = body!.indexOf('FROM auth.users AS auth_user')
    const pairLock = body!.indexOf("'direct-message:pair:' || v_pair")
    const profileLock = body!.indexOf('FROM public.user_profiles AS profile')
    const blockInsert = body!.indexOf('INSERT INTO public.blocked_users AS block_edge')
    const followDelete = body!.indexOf('DELETE FROM public.user_follows AS follow_edge')
    const recount = body!.indexOf('pg_catalog.count(*) FILTER')

    expect(authLock).toBeGreaterThan(0)
    expect(authLock).toBeLessThan(pairLock)
    expect(pairLock).toBeLessThan(profileLock)
    expect(profileLock).toBeLessThan(blockInsert)
    expect(blockInsert).toBeLessThan(followDelete)
    expect(followDelete).toBeLessThan(recount)
    expect(body).toMatch(/ORDER BY auth_user\.id[\s\S]*FOR KEY SHARE/)
    expect(body).toMatch(/ORDER BY profile\.id[\s\S]*FOR UPDATE/)
  })

  it('atomically inserts the block, removes both follow directions, and repairs counts', () => {
    expect(migration).toMatch(
      /INSERT INTO public\.blocked_users AS block_edge[\s\S]*ON CONFLICT \(blocker_id, blocked_id\) DO NOTHING[\s\S]*RETURNING true INTO v_changed/
    )
    expect(migration).toContain('v_removed_outgoing := EXISTS')
    expect(migration).toContain('v_removed_incoming := EXISTS')
    expect(migration).toMatch(
      /DELETE FROM public\.user_follows AS follow_edge[\s\S]*follow_edge\.follower_id = p_actor_id[\s\S]*follow_edge\.follower_id = p_target_id/
    )
    expect(migration.match(/pg_catalog\.count\(\*\) FILTER/g)).toHaveLength(4)
    expect(migration).toContain('UPDATE public.user_profiles AS profile')
    expect(migration).toContain("'blocked' ELSE 'already_blocked'")
    expect(migration).toContain("'unblocked' ELSE 'already_unblocked'")
  })

  it('allows inactive-target unblock cleanup while requiring active block targets', () => {
    expect(migration).toContain("IF p_action = 'block' AND (")
    expect(migration).toContain('NOT v_target_exists')
    expect(migration).toContain('v_target.deleted_at IS NOT NULL')
    expect(migration).toContain("IF p_action = 'block' THEN")
    expect(migration).toMatch(
      /ELSE[\s\S]*DELETE FROM public\.blocked_users AS block_edge[\s\S]*block_edge\.blocker_id = p_actor_id/
    )
  })

  it('cuts both methods over to one strict RPC and invalidates both follow caches', () => {
    expect(route).toContain("supabase.rpc('mutate_user_block_atomic'")
    expect(route).toContain('blockResultSchema.safeParse(data)')
    expect(route).toContain('validateCsrfToken')
    expect(route).toContain('invalidateFollowingCache(actorId.data)')
    expect(route).toContain('invalidateFollowingCache(targetUserId)')
    expect(route).not.toMatch(
      /\.from\(['"](?:blocked_users|user_follows)['"]\)[\s\S]{0,200}?\.(insert|delete|update|upsert)\(/
    )
    expect(route).not.toContain('Promise.all([removeA, removeB])')
  })
})
