import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260803106000_durable_comment_reaction_count_repair.sql'
  ),
  'utf8'
)
const pg17Proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/durable-comment-reaction-count-repair.pg17.sh'
  ),
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

describe('durable comment reaction count repair migration', () => {
  it('is transactional and freezes auth -> posts -> comments -> source', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('public.comment-reaction-count-repair:migration')

    const graphLock = migration.indexOf('LOCK TABLE auth.users,')
    const postLock = migration.indexOf('public.posts,', graphLock)
    const commentLock = migration.indexOf('public.comments,', postLock)
    const sourceLock = migration.indexOf('public.comment_likes', commentLock)
    const preflight = migration.indexOf('DO $preflight$')
    const queueDdl = migration.indexOf('CREATE TABLE IF NOT EXISTS')
    expect(graphLock).toBeGreaterThan(0)
    expect(postLock).toBeGreaterThan(graphLock)
    expect(commentLock).toBeGreaterThan(postLock)
    expect(sourceLock).toBeGreaterThan(commentLock)
    expect(graphLock).toBeLessThan(preflight)
    expect(preflight).toBeLessThan(queueDdl)
    expect(migration).toContain('IN SHARE ROW EXCLUSIVE MODE')
  })

  it('owns a private coalescing queue with no parent foreign key', () => {
    const tableStart = migration.indexOf(
      'CREATE TABLE IF NOT EXISTS public.comment_reaction_count_repair_queue'
    )
    const tableEnd = migration.indexOf(');', tableStart)
    const tableBody = migration.slice(tableStart, tableEnd)

    expect(tableBody).toContain('comment_id uuid PRIMARY KEY')
    expect(tableBody).toContain('enqueued_at timestamptz NOT NULL')
    expect(tableBody).toContain('next_attempt_at timestamptz NOT NULL')
    expect(tableBody).toContain('attempt_count integer NOT NULL DEFAULT 0')
    expect(tableBody).not.toContain('REFERENCES')
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('DO $revoke_queue_acl_drift$')
    expect(migration).toContain('historical roles unknown to this migration')
    expect(migration).toContain('comment reaction count repair queue ACL/RLS policy leaked')
    expect(migration).toContain("access_method.amname = 'btree'")
    expect(migration).toContain('index_row.indislive')
    expect(migration).toContain("index_row.indoption = '0 0 0'::pg_catalog.int2vector")
  })

  it('enqueues every count-affecting child mutation without parent or advisory locks', () => {
    const enqueue = functionBody('enqueue_comment_reaction_count_repair')
    expect(enqueue).toContain("TG_TABLE_NAME IS DISTINCT FROM 'comment_likes'")
    expect(enqueue).toContain("TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')")
    expect(enqueue).toContain('OLD.comment_id IS DISTINCT FROM NEW.comment_id')
    expect(enqueue.match(/ON CONFLICT \(comment_id\) DO NOTHING/g)).toHaveLength(2)
    expect(enqueue).not.toContain('pg_advisory')
    expect(enqueue).not.toContain('auth.users')
    expect(enqueue).not.toContain('public.posts')
    expect(enqueue).not.toContain('public.comments')
    expect(enqueue).not.toContain('UPDATE public.comments')
    expect(migration).toContain('trg_comment_likes_90_enqueue_count_repair')
    expect(migration).toContain('AFTER INSERT OR DELETE OR UPDATE OF comment_id, reaction_type')
  })

  it('keeps synchronous counters only inside the canonical legacy toggle path', () => {
    const sync = functionBody('sync_comment_reaction_counts')
    const pathGuard = sync.indexOf("IS DISTINCT FROM 'toggle_comment_reaction'")
    const update = sync.indexOf('UPDATE public.comments AS target')
    expect(pathGuard).toBeGreaterThan(0)
    expect(update).toBeGreaterThan(pathGuard)
    expect(sync).toContain("'app.comment_reaction_path'")
    expect(sync).toContain('RETURN OLD')
    expect(sync).toContain('RETURN NEW')
    expect(sync).not.toContain('comment_reaction_count_repair_queue')

    const guard = functionBody('guard_contract_comment_reaction_counts')
    expect(guard).toContain("'app.comment_reaction_repair_path'")
    expect(guard).toContain("'repair_comment_reaction_counts_atomic'")
    expect(guard).toContain('direct comment reaction counter updates are disabled')
  })

  it('preserves the legacy signature and puts the actor account before the old chain', () => {
    const wrapper = functionBody('toggle_comment_reaction')
    const actorLock = wrapper.indexOf('FROM auth.users AS actor_account')
    const blockLock = wrapper.indexOf('public.lock_post_interaction_block_edges')
    const sealedImpl = wrapper.indexOf('public.toggle_comment_reaction_locked_impl')

    expect(wrapper).toContain("p_reaction_type text DEFAULT 'like'")
    expect(wrapper).toContain('RETURNS jsonb')
    expect(wrapper).toContain('FOR KEY SHARE')
    expect(actorLock).toBeGreaterThan(0)
    expect(blockLock).toBeGreaterThan(actorLock)
    expect(sealedImpl).toBeGreaterThan(blockLock)
    expect(migration).toContain('atomic-comment-block-authorization:v1:')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.toggle_comment_reaction(')
  })

  it('repairs with post -> comment -> queue ownership before absolute recount', () => {
    const worker = functionBody('repair_comment_reaction_counts_atomic')
    const postLock = worker.indexOf('INTO v_locked_post_id')
    const commentLock = worker.indexOf('INTO v_locked_comment_id')
    const queueLock = worker.indexOf(
      'FROM public.comment_reaction_count_repair_queue AS claimed_queue'
    )
    const queueDelete = worker.indexOf(
      'DELETE FROM public.comment_reaction_count_repair_queue AS claimed_queue'
    )
    const sourceCount = worker.indexOf('pg_catalog.count(*) FILTER')
    const commentUpdate = worker.indexOf('UPDATE public.comments AS target')

    expect(postLock).toBeGreaterThan(0)
    expect(commentLock).toBeGreaterThan(postLock)
    expect(queueLock).toBeGreaterThan(commentLock)
    expect(queueDelete).toBeGreaterThan(queueLock)
    expect(sourceCount).toBeGreaterThan(queueDelete)
    expect(commentUpdate).toBeGreaterThan(sourceCount)
    expect(worker).toContain('FOR SHARE SKIP LOCKED')
    expect(worker).toContain('FOR UPDATE SKIP LOCKED')
    expect(worker).not.toContain('pg_advisory')
    expect(worker).toContain("reaction.reaction_type = 'like'")
    expect(worker).toContain("reaction.reaction_type = 'dislike'")
    expect(worker).toContain('like_count = v_like_count::integer')
    expect(worker).toContain('dislike_count = v_dislike_count::integer')
  })

  it('bounds work to one identity, backs off contention, and reports backlog telemetry', () => {
    const worker = functionBody('repair_comment_reaction_counts_atomic')
    expect(worker).toContain('p_limit integer DEFAULT 1')
    expect(worker).toContain('p_limit IS DISTINCT FROM 1')
    expect(worker).toContain('LIMIT 1')
    expect(worker).toContain('EXIT WHEN v_processed_count >= p_limit')
    expect(worker).toContain('next_attempt_at <= pg_catalog.statement_timestamp()')
    expect(worker).toContain('attempt_count = LEAST(')
    expect(worker).toContain('pg_catalog.make_interval')
    for (const key of [
      'selected_count',
      'processed_count',
      'repaired_count',
      'discarded_count',
      'contended_count',
      'has_more',
      'remaining_count',
      'oldest_enqueued_at',
    ]) {
      expect(worker).toContain(`'${key}'`)
    }
  })

  it('backfills only exact cache/source mismatches and attests their Q coverage', () => {
    const backfill = migration.slice(
      migration.indexOf('-- Enqueue only proven cache/source mismatches.'),
      migration.indexOf('DO $postflight$')
    )
    expect(backfill).toContain('LEFT JOIN (')
    expect(backfill).toContain("reaction.reaction_type = 'like'")
    expect(backfill).toContain("reaction.reaction_type = 'dislike'")
    expect(backfill).toContain(
      'target.like_count IS DISTINCT FROM COALESCE(source_counts.like_count, 0)'
    )
    expect(backfill).toContain('ON CONFLICT (comment_id) DO NOTHING')
    expect(backfill).not.toContain('UNION')
    expect(migration).toContain(
      'comment reaction cache mismatch is missing a durable repair obligation'
    )
  })

  it('attests exact trigger timing, operations, UPDATE OF vectors, and no WHEN predicate', () => {
    expect(migration.match(/trigger_row\.tgqual IS NULL/g)?.length).toBeGreaterThanOrEqual(3)
    expect(migration).toContain('trigger_row.tgtype = 29')
    expect(migration).toContain('trigger_row.tgtype = 23')
    expect(migration).toContain("ARRAY['comment_id', 'user_id', 'reaction_type']::text[]")
    expect(migration).toContain("ARRAY['comment_id', 'reaction_type']::text[]")
    expect(migration).toContain("ARRAY['like_count', 'dislike_count']::text[]")
  })

  it('ships executable PG17 cascade, direct-DML, replay, ACL and lock proofs', () => {
    for (const marker of [
      'auth_account_cascade',
      'direct_comment_like_dml',
      'comment_cascade',
      'post_cascade',
      'queue_rebuild_on_replay',
      'schema_drift_probe',
      'unknown_acl_drift',
      'wrong_queue_index_drift',
      'wrong_trigger_when_false',
      'wrong_update_of_drift',
      'live_toggle_vs_auth_delete',
      'worker_vs_comment_delete',
      'worker_vs_post_delete',
      'worker_vs_auth_delete',
      "wait_event_type = 'Lock'",
      'psql_cmd -f "$MIGRATION"',
      'durable comment reaction count repair PG17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
