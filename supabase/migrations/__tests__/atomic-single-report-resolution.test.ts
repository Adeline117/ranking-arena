import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '../../..')
const migration = readFileSync(
  join(root, 'supabase/migrations/20260716163000_atomic_single_report_resolution.sql'),
  'utf8'
)
const route = readFileSync(join(root, 'app/api/admin/reports/[id]/resolve/route.ts'), 'utf8')
const databaseTypes = readFileSync(join(root, 'lib/supabase/database.types.ts'), 'utf8')
const pg17Proof = readFileSync(
  join(root, 'supabase/migrations/__tests__/atomic-single-report-resolution.pg17.sh'),
  'utf8'
)

describe('atomic single report resolution migration', () => {
  it('installs a sealed service-only transactional RPC without drift-hiding DDL', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.resolve_content_report_atomic(')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain("SET lock_timeout = '5s'")
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.resolve_content_report_atomic\(uuid, uuid, text, text\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.resolve_content_report_atomic\(uuid, uuid, text, text\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-single-report-resolution:v1:')
    expect(migration).not.toMatch(/(?:CREATE|ALTER|ADD|DROP)[^;\n]*IF NOT EXISTS/i)
  })

  it('fails closed on exact schema, FK, constraint, trigger, dependency, and ACL drift', () => {
    for (const table of ['admin_logs', 'comments', 'content_reports', 'posts', 'user_profiles']) {
      expect(migration).toContain(`'${table}'`)
    }
    expect(migration).toContain('auth.users identity authority is incompatible')
    expect(migration).toContain('canonical content report CHECK constraints drifted')
    expect(migration).toContain('single report resolution FK authority drifted')
    expect(migration).toContain('trg_comments_00_guard_canonical_mutation')
    expect(migration).toContain('trg_comments_10_cascade_soft_delete')
    expect(migration).toContain('canonical comment moderation trigger contract drifted')
    expect(migration).toContain('report-moderation-operation-id:v1:')
    expect(migration).toContain('4796e70c1a1d65b6ce16ff9359f6fcf6')
    expect(migration).toContain('public.moderate_report_queue_atomic(uuid,text,uuid,text,uuid)')
    expect(migration).toContain('moderation dependency ACL drifted')
    expect(migration).toContain('atomic single report resolution ACL drifted')
  })

  it('uses the shared target lock before ordered auth parents and all child row locks', () => {
    const functionBody = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.resolve_content_report_atomic('),
      migration.indexOf('ALTER FUNCTION public.resolve_content_report_atomic(')
    )
    const targetLock = functionBody.indexOf("'report-moderation:'")
    const authLock = functionBody.indexOf('FROM auth.users AS auth_user')
    const actorProfileLock = functionBody.indexOf('FROM public.user_profiles AS actor_profile')
    const firstForShare = functionBody.indexOf('FOR SHARE')
    const firstForUpdate = functionBody.indexOf('FOR UPDATE')

    expect(targetLock).toBeGreaterThan(0)
    expect(authLock).toBeGreaterThan(targetLock)
    expect(actorProfileLock).toBeGreaterThan(authLock)
    expect(firstForShare).toBeGreaterThan(authLock)
    expect(firstForUpdate).toBeGreaterThan(authLock)
    expect(functionBody).toContain('ORDER BY auth_user.id')
    expect(functionBody).toContain('v_candidate_parent_author_id')
    expect(functionBody).toContain('v_candidate_reporter_id')
  })

  it('soft-deletes canonical post/comment content and never hard-deletes any bound row', () => {
    const functionBody = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.resolve_content_report_atomic('),
      migration.indexOf('ALTER FUNCTION public.resolve_content_report_atomic(')
    )
    expect(functionBody).toContain('UPDATE public.posts AS moderated_post')
    expect(functionBody).toContain("'soft_delete'")
    expect(functionBody).toContain('FROM public.moderate_comment(')
    expect(functionBody).toContain("v_result_action_taken := 'content_deleted'")
    expect(functionBody).toContain("v_result_action_taken := 'content_already_absent'")
    expect(functionBody).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(functionBody).not.toContain('hard_delete')
  })

  it('transitions exactly one immutable pending report and audits in the same transaction', () => {
    expect(migration).toMatch(
      /UPDATE public\.content_reports AS transitioned_report[\s\S]*transitioned_report\.id = p_report_id[\s\S]*transitioned_report\.reporter_id = v_candidate_reporter_id[\s\S]*transitioned_report\.status = 'pending'[\s\S]*transitioned_report\.content_type = v_candidate_content_type[\s\S]*transitioned_report\.content_id = v_candidate_content_id_text/
    )
    expect(migration).toContain('IF v_report_update_count <> 1 THEN')
    expect(migration).toContain('INSERT INTO public.admin_logs (')
    expect(migration).toContain('RETURNING id INTO admin_log_id')
    expect(migration).toContain("'resolved_at', v_now")
    expect(migration).not.toMatch(
      /UPDATE public\.content_reports[\s\S]*content_id = v_candidate_content_id_text[\s\S]*status = 'pending'/
    )
  })

  it('requires one exact same-actor audit before acknowledging an outcome-equivalent retry', () => {
    expect(migration).toContain('processed report actor evidence conflicts with this retry')
    expect(migration).toContain('pg_catalog.cardinality(v_audit_ids) <> 1')
    expect(migration).toContain('exact atomic report audit evidence is missing')
    expect(migration).toContain("'resolved_at'")
    expect(migration).toContain("v_audit_details -> 'reason' IS DISTINCT FROM COALESCE(")
    expect(migration).toContain('queue audit does not cover the exact atomic report batch')
    expect(migration).toContain('destructive audit evidence conflicts with active content')
    expect(migration).toContain('admin_log_id := v_audit_id')
    expect(migration).toContain("v_candidate_content_type NOT IN ('post', 'comment')")
    expect(migration).toContain("ERRCODE = '0A000'")
  })

  it('normalizes optional reason text and bounds every non-null reason', () => {
    expect(migration).toContain("v_reason := NULLIF(pg_catalog.btrim(p_reason), '')")
    expect(migration).toContain('pg_catalog.char_length(v_reason) > 500')
    expect(migration).toContain("COALESCE(v_reason, 'Report resolved by moderator')")
  })

  it('ships executable replay, rollback, ACL, and bidirectional concurrency proofs', () => {
    expect(pg17Proof).toContain('psql_cmd -f "$MIGRATION"')
    expect(pg17Proof.match(/psql_cmd -f "\$MIGRATION"/g)).toHaveLength(2)
    expect(pg17Proof).toContain('transition_rollback_proof')
    expect(pg17Proof).toContain('audit_rollback_proof')
    expect(pg17Proof).toContain('acl_proof')
    expect(pg17Proof).toContain('sed -n \'429,1357p\' "$OPERATION_MIGRATION"')
    expect(pg17Proof).toContain('forged_audit_evidence_proof')
    expect(pg17Proof).toContain('exact_queue_batch_retry_proof')
    for (const marker of [
      'queue_first_marker',
      'single_first_queue_marker',
      'submit_first_marker',
      'single_first_submit_marker',
      'actor_resolution_first_marker',
      'actor_delete_first_marker',
      'author_resolution_first_marker',
      'author_delete_first_marker',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})

describe('single report resolution call site', () => {
  it('is RPC-only with strict acknowledgement and no direct mutation or rollout fallback', () => {
    expect(route).toContain("supabase.rpc('resolve_content_report_atomic'")
    expect(route).toContain('ATOMIC_RESULT_KEYS')
    expect(route).toContain('keys.length !== ATOMIC_RESULT_KEYS.length')
    expect(route).toContain('candidate.admin_log_id === null')
    expect(route).not.toMatch(
      /\.from\(\s*['"](?:content_reports|posts|comments|admin_logs)['"]\s*\)/
    )
    expect(route).not.toContain('moderateCommentWithRollout')
    expect(route).not.toContain('hard_delete')
  })

  it('keeps generated database types aligned with the RPC table result', () => {
    expect(databaseTypes).toContain('resolve_content_report_atomic: {')
    for (const key of [
      'action_taken',
      'admin_log_id',
      'applied',
      'content_affected_count',
      'content_id',
      'content_soft_deleted',
      'content_type',
      'report_id',
      'report_status',
      'result_action',
      'result_code',
    ]) {
      expect(databaseTypes).toContain(`${key}:`)
    }
  })
})
