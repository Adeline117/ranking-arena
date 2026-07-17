import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716190000_atomic_user_follow.sql'),
  'utf8'
)
const route = readFileSync(join(process.cwd(), 'app/api/users/follow/route.ts'), 'utf8')

describe('atomic user follow boundary', () => {
  it('is a bounded transactional expand migration', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('DO $preflight$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('20260716192000 closes that compatibility window')
  })

  it('depends on exact social schemas, unique keys, and the canonical pair serializer', () => {
    for (const relation of [
      'auth.users',
      'public.user_profiles',
      'public.user_follows',
      'public.blocked_users',
    ]) {
      expect(migration).toContain(relation)
    }
    for (const column of [
      'deleted_at',
      'banned_at',
      'is_banned',
      'ban_expires_at',
      'follower_count',
      'following_count',
    ]) {
      expect(migration).toContain(`'${column}'`)
    }
    expect(migration).toContain("ARRAY['follower_id', 'following_id']::name[]")
    expect(migration).toContain("ARRAY['blocker_id', 'blocked_id']::name[]")
    expect(migration).toContain('public.serialize_direct_message_pair_edge()')
    expect(migration).toContain('trg_serialize_dm_block_pair')
    expect(migration).toContain('trg_serialize_dm_follow_pair')
    expect(migration).toContain("'direct-message:pair:' || v_pair")
    expect(migration).toContain('pg_catalog.pg_inherits')
  })

  it('publishes exactly one service-only security-definer mutation RPC', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.mutate_user_follow_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_target_id uuid,[\s\S]*p_action text[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role(), ''), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.mutate_user_follow_atomic(uuid, uuid, text)'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.mutate_user_follow_atomic(uuid, uuid, text)'
    )
    expect(migration).toContain('atomic user follow EXECUTE boundary drifted')
    expect(migration).toContain('incompatible mutate_user_follow_atomic overload exists')
  })

  it('uses Auth, pair, and profile locks in a globally stable order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.mutate_user_follow_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const authLock = body!.indexOf('FROM auth.users AS auth_user')
    const pairLock = body!.indexOf("'direct-message:pair:' || v_pair")
    const profileLock = body!.indexOf('FROM public.user_profiles AS profile')
    const blockCheck = body!.indexOf('FROM public.blocked_users AS block_edge')
    const mutation = body!.indexOf('INSERT INTO public.user_follows AS follow_edge')
    const recount = body!.indexOf('pg_catalog.count(*) FILTER')
    const counterUpdate = body!.indexOf('UPDATE public.user_profiles AS profile')

    expect(authLock).toBeGreaterThan(0)
    expect(authLock).toBeLessThan(pairLock)
    expect(pairLock).toBeLessThan(profileLock)
    expect(profileLock).toBeLessThan(blockCheck)
    expect(blockCheck).toBeLessThan(mutation)
    expect(mutation).toBeLessThan(recount)
    expect(recount).toBeLessThan(counterUpdate)
    expect(body).toMatch(/ORDER BY auth_user\.id[\s\S]*FOR KEY SHARE/)
    expect(body).toMatch(/ORDER BY profile\.id[\s\S]*FOR UPDATE/)
    expect(body).toContain('LEAST(p_actor_id::text, p_target_id::text)')
    expect(body).toContain('GREATEST(p_actor_id::text, p_target_id::text)')
  })

  it('fails closed on invalid, self, inactive, and blocked relationships', () => {
    for (const status of [
      'invalid',
      'self',
      'actor_unavailable',
      'target_unavailable',
      'blocked',
    ]) {
      expect(migration).toContain(`'status', '${status}'`)
    }
    expect(migration).toContain("p_action NOT IN ('follow', 'unfollow')")
    expect(migration).toContain('profile.deleted_at')
    expect(migration).toContain('profile.banned_at')
    expect(migration).toContain('v_actor.ban_expires_at > v_now')
    expect(migration).toContain('v_target.ban_expires_at > v_now')
  })

  it('makes retries idempotent and repairs both profiles from absolute edge counts', () => {
    expect(migration).toMatch(
      /ON CONFLICT \(follower_id, following_id\) DO NOTHING[\s\S]*RETURNING true INTO v_changed/
    )
    expect(migration).toContain("'followed' ELSE 'already_following'")
    expect(migration).toContain("'unfollowed' ELSE 'already_not_following'")
    expect(migration.match(/pg_catalog\.count\(\*\) FILTER/g)).toHaveLength(4)
    expect(migration).toContain('follower_count = CASE')
    expect(migration).toContain('following_count = CASE')
    for (const key of [
      'following',
      'followed_by',
      'mutual',
      'actor_follower_count',
      'actor_following_count',
      'target_follower_count',
      'target_following_count',
    ]) {
      expect(migration).toContain(`'${key}'`)
    }
  })

  it('cuts POST over to one strict RPC without changing visible UI files', () => {
    expect(route).toContain("supabase.rpc('mutate_user_follow_atomic'")
    expect(route).toContain('followMutationSchema')
    expect(route).toContain('followResultSchema.safeParse(data)')
    expect(route).toContain('validateCsrfToken')
    expect(route).not.toMatch(
      /\.from\(['"]user_follows['"]\)[\s\S]{0,180}?\.(insert|delete|update|upsert)\(/
    )
    expect(route).not.toContain('updateFollowCounts')
    expect(route).not.toContain('Could not find the table')
  })
})
