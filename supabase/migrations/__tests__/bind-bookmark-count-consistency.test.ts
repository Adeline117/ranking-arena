import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260803105000_bind_bookmark_count_consistency.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/bind-bookmark-count-consistency.pg17.sh'),
  'utf8'
)

const bookmarkAuthorities = [
  'toggle_post_bookmark_atomic(uuid, uuid, uuid)',
  'save_post_bookmark_to_folder_atomic(uuid, uuid)',
  'remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid)',
] as const

describe('bookmark count consistency migration', () => {
  it('is transactional and freezes parents, sources and Q in canonical order', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('public.post-bookmark-count-consistency:migration')
    expect(migration).toMatch(
      /LOCK TABLE auth\.users,[\s\S]*public\.posts,[\s\S]*public\.bookmark_folders,[\s\S]*public\.post_bookmarks,[\s\S]*public\.post_interaction_count_repair_queue[\s\S]*IN SHARE ROW EXCLUSIVE MODE/
    )
  })

  it('preserves all three RPC signatures while enforcing P then B', () => {
    for (const signature of bookmarkAuthorities) {
      expect(migration).toContain(`FUNCTION public.${signature}`)
    }
    expect(migration.match(/'post-reaction-counts:' \|\| p_post_id::text/g)).toHaveLength(3)
    expect(migration.match(/'post-bookmark:' \|\| p_post_id::text/g)).toHaveLength(3)
    expect(migration).toContain('v_actor_lock <= v_post_lock')
    expect(migration).toContain('v_account_lock <= v_actor_lock')
    expect(migration).toContain('v_auth_lock <= v_account_lock')
    expect(migration).toContain('v_profile_lock <= v_auth_lock')
    expect(migration).toContain('v_audience_lock <= v_profile_lock')
    expect(migration.match(/FROM auth\.users AS actor_account/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('keeps explicit folder locks before child ownership and absolute ACK counts', () => {
    expect(migration).toContain('Explicit-folder toggles always establish folder -> child order')
    expect(migration).toContain('v_child_lock <= v_folder_lock')
    expect(
      migration.match(/FROM public\.bookmark_folders AS folder/g)?.length
    ).toBeGreaterThanOrEqual(4)
    expect(migration.match(/SELECT pg_catalog\.count\(\*\)/g)?.length).toBeGreaterThanOrEqual(4)
    expect(migration.match(/SET bookmark_count =/g)?.length).toBeGreaterThanOrEqual(3)
    for (const field of [
      "'status'",
      "'bookmark_id'",
      "'folder_id'",
      "'bookmarked'",
      "'bookmark_count'",
    ]) {
      expect(migration).toContain(field)
    }
  })

  it('extends the lock-free durable trigger and bounded P-posts-Q worker', () => {
    expect(migration).toContain(
      "TG_TABLE_NAME NOT IN ('post_likes', 'post_votes', 'post_bookmarks')"
    )
    expect(migration).toContain('trg_post_bookmarks_90_enqueue_count_repair')
    expect(migration).toContain('AFTER INSERT OR DELETE OR UPDATE OF post_id')
    expect(migration).toContain('pg_try_advisory_xact_lock')
    expect(migration).toContain('FROM public.posts AS locked_post')
    expect(migration).toContain('INTO v_claimed_post_id')
    expect(migration).toContain('DELETE FROM public.post_interaction_count_repair_queue')
    expect(migration).toContain('bookmark_count = v_bookmark_count::integer')
    expect(migration).toContain('p_limit IS DISTINCT FROM 1')
    expect(migration).toContain('next_attempt_at')
  })

  it('fails closed on the complete 1040 queue and shared authority substrate', () => {
    for (const marker of [
      "'post_id',\n    'enqueued_at',\n    'next_attempt_at',\n    'attempt_count'",
      "constraint_row.contype = 'p'",
      "constraint_row.contype = 'f'",
      'CHECK (attempt_count >= 0 AND attempt_count <= 1000000)',
      'relation.relforcerowsecurity',
      '1040 repair queue private ACL drifted',
      "access_method.amname = 'btree'",
      'index_row.indislive',
      "index_row.indoption = '0 0 0'::pg_catalog.int2vector",
      'toggle_post_reaction(uuid,uuid,text)',
      'set_post_reaction_desired_state_atomic(uuid,uuid,text)',
      'toggle_post_vote_atomic(uuid,uuid,text)',
      'set_post_vote_desired_state_atomic(uuid,uuid,text)',
      'trg_post_likes_90_enqueue_count_repair',
      'trg_post_votes_90_enqueue_count_repair',
      "ARRAY['post_id', 'reaction_type']::text[]",
      "ARRAY['post_id', 'choice']::text[]",
      'trigger_row.tgqual IS NULL',
    ]) {
      expect(migration).toContain(marker)
    }
  })

  it('backfills only grouped exact mismatches and closes arithmetic and TRUNCATE escape hatches', () => {
    expect(migration).toContain('SELECT bookmark.post_id, pg_catalog.count(*) AS exact_count')
    expect(migration).toContain('target.bookmark_count::bigint IS DISTINCT FROM')
    expect(migration).toContain('COALESCE(source_truth.exact_count, 0::bigint)')
    expect(migration).not.toContain('target.bookmark_count IS DISTINCT FROM 0')
    expect(migration).toContain('increment_bookmark_count(uuid)')
    expect(migration).toContain('decrement_bookmark_count(uuid)')
    expect(migration).toMatch(
      /REVOKE TRUNCATE ON TABLE public\.post_bookmarks[\s\S]*FROM PUBLIC, anon, authenticated, authenticator, service_role/
    )
  })

  it('converges exact caller ACLs without grant option', () => {
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.toggle_post_bookmark_atomic\(uuid, uuid, uuid\)[\s\S]*TO service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.save_post_bookmark_to_folder_atomic\(uuid, uuid\)[\s\S]*TO authenticated/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.remove_post_bookmark_from_folder_atomic\(uuid, uuid, uuid\)[\s\S]*TO authenticated/
    )
    expect(migration).toContain('acl_entry.is_grantable')
    expect(migration).toContain('close_function_acl_drift')
  })

  it('ships a real PG17 semantics, replay, drift and concurrency proof', () => {
    for (const marker of [
      'bookmark count consistency PG17 proof passed',
      'P -> B -> account recovery breaks the former three-way cycle',
      'clean replay added no bookmark repair work',
      'concurrent same-post bookmark writers',
      'save pins auth.users against concurrent account deletion',
      'direct mutation re-enqueues Q after an in-flight drain',
      'auth cascade never waits on P',
      'folder cascade enqueues every affected post',
      'migration accepted queue schema drift',
      'migration accepted missing queue ordering index',
      'migration accepted non-default queue ordering index',
      'migration accepted shared P authority drift',
      'migration accepted wrong-column reaction repair trigger',
      'migration accepted conditional reaction repair trigger',
      'grouped mismatch backfill stays within the scale budget',
      'replay reconverged bookmark authority',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
