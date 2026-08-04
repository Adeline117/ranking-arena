import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260803108000_comment_reaction_causal_intents.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/comment-reaction-causal-intents.pg17.sh'),
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

describe('comment reaction causal intent expansion', () => {
  it('is transactional, shares the migration gate, and explicitly limits its guarantee', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("'public.comment-reaction-count-repair:migration'")
    expect(migration).toMatch(/reservation\s+--\s+order at the database/)
    expect(migration).toMatch(/not by an unobservable physical click order/)
    expect(migration).toContain('This is an expand migration')
    expect(migration).toContain(
      "'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'"
    )
  })

  it('creates a cascade-owned bounded head and replay ledger', () => {
    for (const marker of [
      'CREATE TABLE IF NOT EXISTS public.comment_reaction_intent_heads',
      'PRIMARY KEY (actor_id, comment_id)',
      'REFERENCES auth.users(id)',
      'REFERENCES public.comments(id)',
      'ON DELETE CASCADE',
      'latest_issued_sequence bigint',
      'latest_applied_sequence bigint',
      'CREATE TABLE IF NOT EXISTS public.comment_reaction_intent_operations',
      'PRIMARY KEY (actor_id, request_id)',
      'UNIQUE (actor_id, comment_id, intent_sequence)',
      'comment_reaction_intent_operations_retention_idx',
      "CHECK (request_id ~ '^[0-9a-f]{32}$')",
      "state IN ('issued', 'applied', 'stale', 'expired')",
      'retain_until > expires_at',
    ]) {
      expect(migration).toContain(marker)
    }
    expect(migration).toContain('DO $table_shape_preflight$')
    expect(migration).toContain('comment reaction causal-intent columns drifted')
    expect(migration).toContain('comment reaction causal head constraints drifted')
    expect(migration).toContain('comment reaction causal operation indexes drifted')
    expect(migration).toContain("constraint_row.confdeltype = 'c'")
    expect(migration).not.toMatch(
      /CONSTRAINT comment_reaction_intent_operations_result_check[\s\S]*?SELECT[\s\S]*?\)\n\);/
    )
    expect(migration).toContain('result ?& ARRAY[')
    expect(migration).toContain('result - ARRAY[')
  })

  it('pins the composed 1070 owner, metadata, source seal, overload and ACL twice', () => {
    expect(migration.match(/comment-reaction-desired-state:v1:/g)).toHaveLength(2)
    expect(migration.match(/pg_catalog\.md5\(v_source\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(migration).toContain('function_row.proowner = v_postgres')
    expect(migration).toContain("function_row.provolatile = 'v'")
    expect(migration).toContain('function_row.prosecdef')
    expect(migration).toContain('pg_catalog.cardinality(function_row.proconfig) = 4')
    expect(migration).toContain("'row_security=off'")
    expect(migration).toContain('acl_entry.grantee NOT IN (function_row.proowner, v_service)')
    expect(migration).toContain('AND NOT acl_entry.is_grantable')
    expect(migration).toContain(
      '1070 desired-state composed authority changed during causal publication'
    )
  })

  it('publishes reserve, causal apply and bounded cleanup as service-only functions', () => {
    for (const signature of [
      'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)',
      'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)',
      'public.cleanup_comment_reaction_intents_atomic(integer)',
    ]) {
      expect(migration).toContain(signature)
    }
    expect(migration).toContain('DO $converge_function_acl$')
    expect(migration).toContain('TO service_role')
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('DO $converge_table_acl$')
    expect(migration).toContain('REVOKE ALL ON TABLE %s FROM %s CASCADE')
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)')
    expect(migration).toContain('REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM %s CASCADE')
    expect(migration).toContain('REVOKE ALL ON FUNCTION %s FROM %s CASCADE')
    expect(migration).toContain('DO $seal_causal_functions$')
    for (const prefix of [
      'comment-reaction-causal-intent:reserve-v1:',
      'comment-reaction-causal-intent:apply-v1:',
      'comment-reaction-causal-intent:cleanup-v1:',
    ]) {
      expect(migration).toContain(prefix)
    }
    expect(migration).toContain(
      'existing comment reaction causal-intent function source seal drifted'
    )
  })

  it.each([
    'reserve_comment_reaction_intent_atomic',
    'set_comment_reaction_desired_state_causal_atomic',
    'cleanup_comment_reaction_intents_atomic',
  ])('%s authenticates before validation, gates, or relation access', (name) => {
    const body = functionBody(name)
    const auth = body.indexOf('service role required')
    const validation = body.indexOf("RETURN pg_catalog.jsonb_build_object('status', 'invalid')")
    const gate = body.indexOf('pg_catalog.pg_try_advisory_xact_lock_shared')
    expect(auth).toBeGreaterThan(0)
    expect(validation).toBeGreaterThan(auth)
    expect(gate).toBeGreaterThan(validation)
  })

  it('uses one request lock and one actor/comment head lock before canonical rows', () => {
    for (const name of [
      'reserve_comment_reaction_intent_atomic',
      'set_comment_reaction_desired_state_causal_atomic',
    ]) {
      const body = functionBody(name)
      const account = body.indexOf('FROM auth.users AS actor_account')
      const requestLock = body.indexOf('comment-reaction-intent-request:')
      const headLock = body.indexOf('comment-reaction-intent-head:')
      const blockEdges = body.indexOf('public.lock_post_interaction_block_edges')
      const post = body.indexOf('FROM public.posts AS target_post')
      const group = body.indexOf('FROM public.groups AS interaction_group')
      const comment = body.indexOf('FROM public.comments AS target_comment')
      const source = body.indexOf('FROM public.comment_likes AS reaction')
      const head = body.indexOf('FROM public.comment_reaction_intent_heads AS head_row')
      expect(requestLock).toBeGreaterThan(account)
      expect(headLock).toBeGreaterThan(requestLock)
      expect(blockEdges).toBeGreaterThan(headLock)
      expect(post).toBeGreaterThan(blockEdges)
      expect(group).toBeGreaterThan(post)
      expect(comment).toBeGreaterThan(group)
      expect(source).toBeGreaterThan(comment)
      expect(head).toBeGreaterThan(source)
    }
  })

  it('reserves immutable decimal-string tickets and makes prior issued work stale', () => {
    const reserve = functionBody('reserve_comment_reaction_intent_atomic')
    expect(reserve).toContain("p_request_id !~ '^[0-9a-f]{32}$'")
    expect(reserve).toContain("'comment-reaction-causal-intent:v1'")
    expect(reserve).toContain('intent_fingerprint IS DISTINCT FROM v_fingerprint')
    expect(reserve).toContain(
      "RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict')"
    )
    expect(reserve).toContain("SET state = 'stale'")
    expect(reserve).toContain('v_head.latest_issued_sequence + 1')
    expect(reserve).toContain("'intent_sequence', v_sequence::text")
    expect(reserve).toContain("'status', 'issued'")
    expect(reserve).toContain("'status', 'replayed'")
    expect(reserve).toContain('YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    expect(reserve).not.toContain("'request_id', p_request_id")
    expect(reserve).not.toContain("'desired_reaction', p_desired_reaction")
    expect(reserve).toContain("interval '30 minutes'")
    expect(reserve).toContain("interval '7 days'")
  })

  it('authorizes reservation without mutating, while preserving revoked-access removal', () => {
    const reserve = functionBody('reserve_comment_reaction_intent_atomic')
    const source = reserve.indexOf('FROM public.comment_likes AS reaction')
    const removalExemption = reserve.indexOf(
      'IF NOT (p_desired_reaction IS NULL AND v_has_current) THEN'
    )
    const authority = reserve.indexOf('public.set_comment_reaction_desired_state_atomic')
    const headInsert = reserve.indexOf('INSERT INTO public.comment_reaction_intent_heads')
    expect(removalExemption).toBeGreaterThan(source)
    expect(authority).toBeGreaterThan(removalExemption)
    expect(headInsert).toBeGreaterThan(authority)
    expect(reserve).toContain("v_authorization ->> 'status' IS DISTINCT FROM 'unchanged'")
  })

  it('rejects unknown, forged, expired, conflicted and stale applies before mutation', () => {
    const apply = functionBody('set_comment_reaction_desired_state_causal_atomic')
    const unknown = apply.indexOf("'status', 'unknown_ticket'")
    const conflict = apply.indexOf("'status', 'operation_conflict'")
    const expired = apply.indexOf("'status', 'expired'")
    const stale = apply.indexOf("'status', 'stale'")
    const authority = apply.indexOf('public.set_comment_reaction_desired_state_atomic')
    expect(unknown).toBeGreaterThan(0)
    expect(conflict).toBeGreaterThan(unknown)
    expect(stale).toBeGreaterThan(conflict)
    expect(expired).toBeGreaterThan(stale)
    expect(authority).toBeGreaterThan(expired)
    expect(apply).toContain('p_intent_sequence <> v_head.latest_issued_sequence')
    expect(apply).toContain('v_operation.intent_sequence IS DISTINCT FROM p_intent_sequence')
    expect(apply).toContain("SET state = 'applied'")
    expect(apply).toContain('latest_applied_sequence = p_intent_sequence')
    const requestLock = apply.indexOf('comment-reaction-intent-request:')
    const earlyOperation = apply.indexOf(
      'FROM public.comment_reaction_intent_operations AS operation_row',
      requestLock
    )
    const headLock = apply.indexOf('comment-reaction-intent-head:', requestLock)
    expect(earlyOperation).toBeGreaterThan(requestLock)
    expect(headLock).toBeGreaterThan(earlyOperation)
    expect(apply.slice(earlyOperation, headLock)).not.toContain('FOR UPDATE')
  })

  it('stores an exact successful result and marks old replays non-current', () => {
    const apply = functionBody('set_comment_reaction_desired_state_causal_atomic')
    expect(apply).toContain('FROM pg_catalog.jsonb_object_keys(v_base_result)')
    expect(apply).toContain(') <> 7')
    for (const key of ['intent_sequence', 'replayed']) {
      expect(apply).toContain(`'${key}'`)
    }
    expect(apply).toContain("'{replayed}'")
    expect(apply).toContain('v_operation.intent_sequence <> v_head.latest_issued_sequence')
    expect(apply).not.toContain("'head_sequence'")
    expect(apply).not.toContain("'is_current'")
  })

  it('cleans only expired operations and inactive heads in bounded batches', () => {
    const cleanup = functionBody('cleanup_comment_reaction_intents_atomic')
    expect(cleanup).toContain('p_limit < 1 OR p_limit > 1000')
    expect(cleanup).toContain('operation_row.retain_until < v_now')
    expect(cleanup).toContain('FOR UPDATE SKIP LOCKED')
    expect(cleanup).toContain("head_row.updated_at < v_now - interval '30 days'")
    expect(cleanup).toContain('comment-reaction-intent-head:')
    expect(cleanup).toContain('FROM auth.users AS actor_account')
    expect(cleanup).toContain('FROM public.comments AS target_comment')
    expect(cleanup).toContain('FROM public.comment_likes AS reaction')
    expect(cleanup).toContain("'operations_deleted'")
    expect(cleanup).toContain("'heads_deleted'")
    expect(cleanup.indexOf('FOR v_candidate IN')).toBeLessThan(
      cleanup.indexOf('WITH expired_operation AS')
    )
  })

  it('ships executable PG17 replay, stale, expiry, ACL, cleanup and cascade proofs', () => {
    for (const marker of [
      'same_request_reservation_replay',
      'same_request_conflict',
      'newer_reservation_fences_delayed_apply',
      'same_ticket_apply_replay',
      'old_success_replay_is_not_current',
      'expired_ticket_rejected',
      'forged_sequence_rejected',
      'bounded_cleanup',
      'account_comment_cascade',
      'service_only_acl',
      'unknown_ticket_no_target_oracle',
      'removal_ticket_replay_after_acl_revoke',
      'cleanup_apply_lock_order',
      'hostile_column_acl_replay',
      'causal_function_seal_drift',
      'comment reaction causal-intent PG17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
