import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260803107000_set_comment_reaction_desired_state.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/set-comment-reaction-desired-state.pg17.sh'),
  'utf8'
)

function functionBody(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`
  const start = migration.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf('$function$;', start)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end + '$function$;'.length)
}

describe('comment reaction desired-state migration', () => {
  it('is transactional and shares the 1060 migration/worker gate', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("'public.comment-reaction-count-repair:migration'")
    expect(migration.match(/pg_catalog\.pg_try_advisory_xact_lock\(/g)).toHaveLength(1)
    expect(migration).toContain('LOCK TABLE auth.users,')
    expect(migration).toContain('public.posts,')
    expect(migration).toContain('public.groups,')
    expect(migration).toContain('public.comments,')
    expect(migration).toContain('public.comment_likes,')
    expect(migration).toContain('public.blocked_users,')
    expect(migration).toContain('public.group_members,')
    expect(migration).toContain('public.group_bans,')
    expect(migration).toContain('public.user_follows,')
    expect(migration).toContain('public.comment_reaction_count_repair_queue')
    expect(migration).toContain('IN SHARE ROW EXCLUSIVE MODE')
  })

  it('publishes one four-argument service-only RPC without request identity', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.set_comment_reaction_desired_state_atomic('
    )
    expect(migration).toContain(
      'p_actor_id uuid,\n  p_post_id uuid,\n  p_comment_id uuid,\n  p_desired_reaction text'
    )
    expect(migration).toContain(
      "'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'"
    )
    expect(migration).toContain(
      "ARRAY[\n      'p_actor_id',\n      'p_post_id',\n      'p_comment_id',\n      'p_desired_reaction'"
    )
    expect(migration).not.toContain('p_request_id')
    expect(migration).not.toContain("'request_id'")
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION')
    expect(migration).toContain('TO service_role')
    expect(migration).toContain('DO $converge_function_acl$')
    expect(migration).toContain('FROM %s CASCADE')
  })

  it('authenticates before validation, gates, or relation access', () => {
    const desired = functionBody('set_comment_reaction_desired_state_atomic')
    const auth = desired.indexOf('service role required')
    const validation = desired.indexOf("p_desired_reaction NOT IN ('like', 'dislike')")
    const gate = desired.indexOf('pg_catalog.pg_try_advisory_xact_lock_shared')
    const account = desired.indexOf('FROM auth.users AS actor_account')

    expect(auth).toBeGreaterThan(0)
    expect(validation).toBeGreaterThan(auth)
    expect(gate).toBeGreaterThan(validation)
    expect(account).toBeGreaterThan(gate)
    expect(desired.match(/pg_try_advisory_xact_lock_shared/g)).toHaveLength(1)
    expect(desired).not.toContain('pg_advisory_xact_lock_shared(')
    expect(desired).toContain("RETURN pg_catalog.jsonb_build_object('status', 'invalid')")
    expect(desired).toContain("RETURN pg_catalog.jsonb_build_object('status', 'not_found')")
  })

  it('owns account -> block edges -> post -> group -> comment -> source -> Q order', () => {
    const desired = functionBody('set_comment_reaction_desired_state_atomic')
    const account = desired.indexOf('FROM auth.users AS actor_account')
    const blockEdges = desired.indexOf('public.lock_post_interaction_block_edges')
    const post = desired.indexOf('FROM public.posts AS target_post')
    const group = desired.indexOf('FROM public.groups AS interaction_group')
    const comment = desired.indexOf('FROM public.comments AS target_comment')
    const source = desired.indexOf('FROM public.comment_likes AS reaction')
    const mutation = desired.indexOf('public.toggle_comment_reaction_locked_impl')
    const queue = desired.indexOf('INSERT INTO public.comment_reaction_count_repair_queue')
    const recount = desired.indexOf('pg_catalog.count(*) FILTER')

    expect(desired).toContain('FOR KEY SHARE')
    expect(desired).toContain('FOR SHARE')
    expect(desired).toContain('FOR UPDATE')
    expect(blockEdges).toBeGreaterThan(account)
    expect(post).toBeGreaterThan(blockEdges)
    expect(group).toBeGreaterThan(post)
    expect(comment).toBeGreaterThan(group)
    expect(source).toBeGreaterThan(comment)
    expect(mutation).toBeGreaterThan(source)
    expect(queue).toBeGreaterThan(mutation)
    expect(recount).toBeGreaterThan(queue)
  })

  it('models every desired-state transition without toggling unchanged retries', () => {
    const desired = functionBody('set_comment_reaction_desired_state_atomic')
    const absent = desired.indexOf('IF NOT v_has_existing THEN')
    const removal = desired.indexOf('ELSIF p_desired_reaction IS NULL THEN')
    const unchanged = desired.indexOf('ELSIF v_existing_type = p_desired_reaction THEN')
    const mutationGuard = desired.indexOf("IF v_action IS DISTINCT FROM 'unchanged' THEN")

    expect(absent).toBeGreaterThan(0)
    expect(removal).toBeGreaterThan(absent)
    expect(unchanged).toBeGreaterThan(removal)
    expect(mutationGuard).toBeGreaterThan(unchanged)
    expect(desired).toContain("v_action := 'added'")
    expect(desired).toContain("v_action := 'removed'")
    expect(desired).toContain("v_action := 'changed'")
    expect(desired).toContain("v_action := 'unchanged'")
    expect(desired).toContain("WHEN v_action = 'removed' THEN v_existing_type")
  })

  it('authorizes unchanged receipts without reversing the parent lock order', () => {
    const desired = functionBody('set_comment_reaction_desired_state_atomic')
    const source = desired.indexOf('FROM public.comment_likes AS reaction')
    const unchangedAuthorization = desired.indexOf("IF v_action = 'unchanged' THEN")
    const mutation = desired.indexOf('public.toggle_comment_reaction_locked_impl')

    expect(unchangedAuthorization).toBeGreaterThan(source)
    expect(mutation).toBeGreaterThan(unchangedAuthorization)
    expect(desired.slice(unchangedAuthorization, mutation)).toContain(
      'v_group_dissolved_at IS NOT NULL'
    )
    expect(desired.slice(unchangedAuthorization, mutation)).toContain(
      'FROM public.blocked_users AS interaction_block'
    )
    expect(desired.slice(unchangedAuthorization, mutation)).toContain(
      'FROM public.blocked_users AS target_interaction_block'
    )
    expect(desired.slice(source, mutation)).toContain(
      'FROM public.blocked_users AS root_interaction_block'
    )
    expect(desired.slice(source, mutation)).toContain("v_action IS DISTINCT FROM 'removed'")
    expect(desired.slice(unchangedAuthorization, mutation)).toContain(
      'FROM public.group_bans AS active_ban'
    )
    expect(desired.slice(unchangedAuthorization, mutation)).toContain(
      'FROM public.group_members AS active_member'
    )
    expect(desired.slice(unchangedAuthorization, mutation)).toContain(
      'FROM public.user_follows AS active_follow'
    )
    expect(desired.slice(unchangedAuthorization, mutation)).not.toContain('FOR SHARE')
    expect(desired.slice(unchangedAuthorization, mutation)).not.toContain('FOR UPDATE')
  })

  it('returns exact canonical truth and never trusts the comment cache', () => {
    const desired = functionBody('set_comment_reaction_desired_state_atomic')
    const legacyCall = desired.indexOf('public.toggle_comment_reaction_locked_impl')
    const queue = desired.indexOf('INSERT INTO public.comment_reaction_count_repair_queue')
    const count = desired.indexOf('pg_catalog.count(*) FILTER')
    const acknowledgement = desired.indexOf('RETURN pg_catalog.jsonb_build_object(', count)

    expect(desired).toContain('FROM pg_catalog.jsonb_object_keys(v_legacy_result)')
    expect(desired).toContain('ON CONFLICT (comment_id) DO NOTHING')
    expect(count).toBeGreaterThan(queue)
    expect(queue).toBeGreaterThan(legacyCall)
    expect(acknowledgement).toBeGreaterThan(count)
    expect(desired).toContain("reaction.reaction_type = 'like'")
    expect(desired).toContain("reaction.reaction_type = 'dislike'")
    expect(desired).not.toContain('target_comment.like_count')
    expect(desired).not.toContain('target_comment.dislike_count')
    for (const key of [
      'status',
      'action',
      'reaction',
      'liked',
      'disliked',
      'like_count',
      'dislike_count',
    ]) {
      expect(desired.slice(acknowledgement)).toContain(`'${key}'`)
    }
  })

  it('pins composed dependency sources and its own source hash', () => {
    for (const prefix of [
      'atomic-comment-block-authorization:v1:',
      'comment-reaction-count-repair:legacy-wrapper-v1:',
      'comment-reaction-count-repair:enqueue-v1:',
      'comment-reaction-count-repair:source-guard-v1:',
      'comment-reaction-count-repair:sync-v1:',
      'comment-reaction-count-repair:guard-v1:',
      'comment-reaction-count-repair:worker-v1:',
      'comment-reaction-desired-state:v1:',
      'comment-reaction-desired-state:block-edge-acquire-v1:',
      'comment-reaction-desired-state:block-edge-lock-v1:',
    ]) {
      expect(migration).toContain(prefix)
    }
    expect(migration).toContain('comment reaction dependency source drifted')
    expect(migration).toContain('comment reaction desired-state source or lock order drifted')
    expect(migration).toContain('ee7b907524e2ad83f81808d6b66b23ef')
    expect(migration).toContain('10644ff85375d6598d9122eb104bc151')
    expect(migration).toContain('comment reaction block-edge authorization dependency drifted')
    expect(migration).toContain('comment reaction block-edge dependency postflight failed')
  })

  it('revalidates source and repair-queue ACL closure before and after publication', () => {
    expect(migration.match(/'public\.comment_likes'/g)?.length).toBeGreaterThanOrEqual(4)
    expect(migration).toContain("acl_entry.privilege_type <> 'SELECT'")
    expect(migration).toContain("'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'")
    expect(migration).toContain('comment reaction source or repair queue ACL boundary drifted')
    expect(migration).toContain('comment reaction source or repair queue ACL postflight failed')
  })

  it('ships executable PG17 replay, ACL, stale-cache, auth and lock proofs', () => {
    for (const marker of [
      'desired_state_replay',
      'desired_state_change',
      'desired_state_remove',
      'stale_cache_absolute_ack',
      'service_only_acl',
      'unknown_acl_drift',
      'dependency_source_drift',
      'block_helper_source_drift',
      'comment_likes_truncate_acl_drift',
      'unchanged_absent_authorization',
      'unchanged_same_state_authorization',
      'removal_after_authorization_revoke',
      'desired_vs_auth_delete',
      "wait_event_type = 'Lock'",
      'psql_cmd -f "$DESIRED_MIGRATION"',
      'comment reaction desired-state PG17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
