import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716114100_atomic_group_member_moderation.sql'),
  'utf8'
)

describe('atomic group member moderation migration contract', () => {
  it('requires the atomic membership layer and fails on pre-existing overlap', () => {
    expect(migration).toContain('public.mutate_group_membership_atomic(uuid,uuid,text,boolean)')
    expect(migration).toContain('atomic membership migration 20260716113900 must be applied first')
    expect(migration).toContain('trg_group_members_05_serialize_edge')
    expect(migration).toContain('trg_group_bans_05_serialize_edge')
    expect(migration).toContain('moderation edge primary keys are incompatible')
    expect(migration).toContain('DO $locked_data_preflight$')
    expect(migration).toContain('existing banned memberships require explicit review')
    expect(migration).not.toMatch(
      /DELETE FROM public\.group_(?:members|bans)[\s\S]{0,200}preflight/i
    )
  })

  it('makes ban/member overlap impossible from either write direction', () => {
    expect(migration).toContain('CREATE TRIGGER trg_group_members_10_reject_ban')
    expect(migration).toContain('CREATE TRIGGER trg_group_bans_10_reject_member')
    expect(migration).toContain('banned user cannot have group membership')
    expect(migration).toContain('group member must be removed before ban insertion')
    expect(migration).toContain('public.serialize_group_membership_edge()')
  })

  it('performs member removal, ban state and audit writes in one RPC', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.moderate_group_member_atomic(')
    expect(migration).toContain("p_action NOT IN ('ban', 'kick', 'unban')")
    expect(migration).toContain('DELETE FROM public.group_members AS member')
    expect(migration).toContain('INSERT INTO public.group_bans')
    expect(migration).toContain('DELETE FROM public.group_bans AS ban')
    expect(migration.match(/INSERT INTO public\.group_audit_log/g)).toHaveLength(3)
    expect(migration).toContain('GET DIAGNOSTICS v_affected_count = ROW_COUNT')
  })

  it('locks both edges and rechecks role hierarchy in the transaction', () => {
    expect(migration).toContain('LEAST(p_actor_id::text, p_target_id::text)')
    expect(migration).toContain('GREATEST(p_actor_id::text, p_target_id::text)')
    expect(migration).toContain('v_actor_is_member := FOUND')
    expect(migration).toContain('v_target_is_member := FOUND')
    expect(migration).toContain("v_actor_role NOT IN ('owner', 'admin')")
    expect(migration).toContain("v_actor_role = 'admin' AND v_target_role = 'admin'")
    expect(migration).toContain("RETURN pg_catalog.jsonb_build_object('status', 'owner_forbidden')")
  })

  it('removes direct ban mutations while preserving bounded reads', () => {
    expect(migration).toContain('DO $converge_ban_acls$')
    expect(migration).toContain(
      'GRANT SELECT ON TABLE public.group_bans TO authenticated, service_role'
    )
    expect(migration).toContain('CREATE POLICY browser_admin_read')
    expect(migration).toContain('CREATE POLICY internal_owner_mutation')
    expect(migration).toContain('CREATE POLICY server_read')
    expect(migration).toContain('group_bans effective ACL drifted')
  })

  it('exposes one exact service-only RPC and no moderation overload', () => {
    expect(migration).toContain('public.moderate_group_member_atomic(uuid,uuid,uuid,text,text)')
    expect(migration).toContain('DO $converge_function_acls$')
    expect(migration).toContain('moderation trigger helper security contract drifted')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, public')
    expect(migration).toContain('unexpected atomic moderation overload remains')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
