import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260803104000_durable_post_interaction_count_repair.sql'
  ),
  'utf8'
)
const pg17Proof = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/__tests__/durable-post-interaction-count-repair.pg17.sh'
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

describe('durable post interaction count repair migration', () => {
  it('is transactional and freezes auth -> posts -> children before changing triggers', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('public.post-interaction-count-repair:migration')

    const graphLock = migration.indexOf('LOCK TABLE auth.users,')
    const preflight = migration.indexOf('DO $preflight$')
    const queueDdl = migration.indexOf('CREATE TABLE IF NOT EXISTS')
    expect(graphLock).toBeGreaterThan(0)
    expect(graphLock).toBeLessThan(preflight)
    expect(preflight).toBeLessThan(queueDdl)
    expect(migration).toContain('IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain(
      'LOCK TABLE public.post_interaction_count_repair_queue\nIN ACCESS EXCLUSIVE MODE'
    )
  })

  it('uses a private no-FK coalescing queue and closes service TRUNCATE', () => {
    const tableStart = migration.indexOf(
      'CREATE TABLE IF NOT EXISTS public.post_interaction_count_repair_queue'
    )
    const tableEnd = migration.indexOf(');', tableStart)
    const tableBody = migration.slice(tableStart, tableEnd)

    expect(tableBody).toContain('post_id uuid PRIMARY KEY')
    expect(tableBody).toContain('enqueued_at timestamptz NOT NULL')
    expect(tableBody).toContain('next_attempt_at timestamptz NOT NULL')
    expect(tableBody).toContain('attempt_count integer NOT NULL DEFAULT 0')
    expect(tableBody).not.toContain('REFERENCES')
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('must not expose RLS policies')
    expect(migration).toContain('post interaction count repair queue ACL leaked')
    expect(migration).toContain('REVOKE TRUNCATE ON TABLE public.post_likes, public.post_votes')
    expect(migration).toContain('post interaction source TRUNCATE authority leaked')
    expect(migration).toContain('public.increment_like_count(uuid)')
    expect(migration).toContain('public.decrement_like_count(uuid)')
    expect(migration).toContain('legacy arithmetic like counter RPC remains callable')
    expect(migration).toContain('DO $revoke_queue_column_acl_drift$')
  })

  it('enqueues every row mutation without taking post or auth locks', () => {
    const enqueue = functionBody('enqueue_post_interaction_count_repair')
    expect(enqueue).toContain("TG_TABLE_NAME NOT IN ('post_likes', 'post_votes')")
    expect(enqueue).toContain("TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')")
    expect(enqueue).toContain('OLD.post_id IS DISTINCT FROM NEW.post_id')
    expect(enqueue.match(/ON CONFLICT \(post_id\) DO NOTHING/g)).toHaveLength(2)
    expect(enqueue).not.toContain('pg_advisory')
    expect(enqueue).not.toContain('auth.users')
    expect(enqueue).not.toContain('UPDATE public.posts')

    for (const marker of [
      'trg_post_likes_90_enqueue_count_repair',
      'trg_post_votes_90_enqueue_count_repair',
      'AFTER INSERT OR DELETE OR UPDATE OF post_id, reaction_type',
      'AFTER INSERT OR DELETE OR UPDATE OF post_id, choice',
    ]) {
      expect(migration).toContain(marker)
    }
  })

  it('takes P -> posts -> Q before absolute recount and never waits on contention', () => {
    const repair = functionBody('repair_post_interaction_counts_atomic')
    const postAdvisory = repair.indexOf('pg_try_advisory_xact_lock')
    const postRow = repair.indexOf('FROM public.posts AS locked_post')
    const queueClaim = repair.indexOf('INTO v_claimed_post_id')
    const queueDelete = repair.indexOf('DELETE FROM public.post_interaction_count_repair_queue')
    const reactionCount = repair.indexOf('WHERE reaction.reaction_type')
    const postUpdate = repair.indexOf('UPDATE public.posts AS target')

    expect(postAdvisory).toBeGreaterThan(0)
    expect(postRow).toBeGreaterThan(postAdvisory)
    expect(queueClaim).toBeGreaterThan(postRow)
    expect(queueDelete).toBeGreaterThan(queueClaim)
    expect(reactionCount).toBeGreaterThan(queueDelete)
    expect(postUpdate).toBeGreaterThan(reactionCount)
    expect(repair).toContain('FOR UPDATE SKIP LOCKED')
    expect(repair).toContain('FROM public.posts AS visible_post')
    expect(repair).toContain('locked post disappeared during interaction count repair')
    expect(repair).not.toContain('pg_advisory_xact_lock(')
  })

  it('uses one post per transaction, defers contention, and returns backlog telemetry', () => {
    const repair = functionBody('repair_post_interaction_counts_atomic')
    expect(repair).toContain('p_limit integer DEFAULT 1')
    expect(repair).toContain('p_limit IS DISTINCT FROM 1')
    expect(repair).toContain('LIMIT 1')
    expect(repair).toContain('EXIT WHEN v_processed_count >= p_limit')
    expect(repair).toContain('next_attempt_at <= pg_catalog.statement_timestamp()')
    expect(repair).toContain('attempt_count = LEAST(repair_queue.attempt_count + 1, 1000000)')
    expect(repair).toContain('pg_catalog.make_interval')
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
      expect(repair).toContain(`'${key}'`)
    }
  })

  it('repairs all five cached values and avoids a nullable full-table backfill', () => {
    const repair = functionBody('repair_post_interaction_counts_atomic')
    for (const marker of [
      "reaction.reaction_type = 'up'",
      "reaction.reaction_type = 'down'",
      "vote.choice = 'bull'",
      "vote.choice = 'bear'",
      "vote.choice = 'wait'",
      'like_count = v_like_count::integer',
      'dislike_count = v_dislike_count::integer',
      'poll_bull = v_bull_count::integer',
      'poll_bear = v_bear_count::integer',
      'poll_wait = v_wait_count::integer',
    ]) {
      expect(repair).toContain(marker)
    }

    for (const field of ['like_count', 'dislike_count', 'poll_bull', 'poll_bear', 'poll_wait']) {
      expect(migration).toContain(`COALESCE(target.${field}, 0) <> 0`)
      expect(migration).not.toContain(`target.${field} IS DISTINCT FROM 0`)
    }
  })

  it('requires every live reaction/vote authority to share the post lock', () => {
    for (const signature of [
      'public.toggle_post_reaction(uuid,uuid,text)',
      'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)',
      'public.toggle_post_vote_atomic(uuid,uuid,text)',
      'public.set_post_vote_desired_state_atomic(uuid,uuid,text)',
    ]) {
      expect(migration).toContain(signature)
    }
    expect(migration).toContain("'''post-reaction-counts:'''")
    expect(migration).toContain(
      'post interaction authority does not share the canonical repair lock'
    )
  })

  it('ships executable PG17 cascade, replay, drift and lock-interleaving proof', () => {
    for (const marker of [
      'auth.users(id) ON DELETE CASCADE',
      '20000000-0000-0000-0000-000000000099',
      'repair_worker_gate',
      'direct_child_delete',
      'concurrent_post_delete',
      'live_post_authority',
      "wait_event_type = 'Lock'",
      'psql_cmd -f "$MIGRATION"',
      'does not share the canonical repair lock',
      'durable post interaction count repair PG17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
