import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716114700_atomic_group_join_requests.sql'),
  'utf8'
)

describe('atomic group join-request migration contract', () => {
  it('requires the 113900 state, index and shared-edge authority', () => {
    expect(migration).toContain('atomic membership migration 20260716113900 must be applied first')
    expect(migration).toContain('public.serialize_group_membership_edge()')
    expect(migration).toContain('trg_group_join_requests_05_enforce_state')
    expect(migration).toContain('group_join_requests_active_edge_unique')
  })

  it('creates or cancels one active request under the membership edge lock', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.mutate_group_join_request_atomic('
    )
    expect(migration).toContain("p_action NOT IN ('request', 'cancel')")
    expect(migration).toContain(
      "'group-membership:' || p_group_id::text || ':' || p_actor_id::text"
    )
    expect(migration).toContain("AND join_request.status IN ('pending', 'approved')")
    expect(migration).toContain("SET status = 'cancelled'")
    expect(migration).toContain("'status', 'requested'")
    expect(migration).toContain("pg_catalog.char_length(COALESCE(p_answer_text, '')) > 2000")
  })

  it('rechecks every B2C join gate before minting pending evidence', () => {
    expect(migration).toContain("RETURN pg_catalog.jsonb_build_object('status', 'banned')")
    expect(migration).toContain("'status', 'score_too_low'")
    expect(migration).toContain("RETURN pg_catalog.jsonb_build_object('status', 'verified_only')")
    expect(migration).toContain(
      "RETURN pg_catalog.jsonb_build_object('status', 'premium_required')"
    )
    expect(migration).toContain("RETURN pg_catalog.jsonb_build_object('status', 'open_group')")
    expect(migration).toContain("v_visibility IS DISTINCT FROM 'apply'")
  })

  it('reviews under actor and applicant edge locks with transactional audit', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.review_group_join_request_atomic('
    )
    expect(migration).toContain('LEAST(p_actor_id::text, v_initial_request.user_id::text)')
    expect(migration).toContain('GREATEST(p_actor_id::text, v_initial_request.user_id::text)')
    expect(migration).toContain("v_actor_role NOT IN ('owner', 'admin')")
    expect(migration).toContain("SET status = 'approved'")
    expect(migration).toContain("SET status = 'rejected'")
    expect(migration).toContain("'join_request_approved'")
    expect(migration).toContain("'join_request_rejected'")
    expect(migration).toContain('GET DIAGNOSTICS v_affected_count = ROW_COUNT')
  })

  it('removes direct mutations while preserving self/admin and server reads', () => {
    expect(migration).toContain('ALTER TABLE public.group_join_requests FORCE ROW LEVEL SECURITY')
    expect(migration).toContain(
      'GRANT SELECT ON TABLE public.group_join_requests TO authenticated, service_role'
    )
    expect(migration).toContain('CREATE POLICY browser_self_or_admin_read')
    expect(migration).toContain('CREATE POLICY internal_owner_mutation')
    expect(migration).toContain('CREATE POLICY server_read')
    expect(migration).toContain('group_join_requests effective ACL drifted')
  })

  it('exposes exactly two service-only RPC entry points', () => {
    expect(migration).toContain(
      'public.mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)'
    )
    expect(migration).toContain('public.review_group_join_request_atomic(uuid,uuid,text)')
    expect(migration).toContain('DO $converge_function_acls$')
    expect(migration).toContain('unexpected atomic group join-request overload remains')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
