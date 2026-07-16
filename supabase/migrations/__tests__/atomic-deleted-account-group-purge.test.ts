import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716114900_atomic_deleted_account_group_purge.sql'),
  'utf8'
)

describe('atomic deleted-account group purge migration contract', () => {
  it('requires the canonical cascade and group-edge dependencies before mutation', () => {
    const preflight = migration.indexOf('DO $preflight$')
    const tableLock = migration.indexOf('LOCK TABLE public.group_members, public.group_bans')
    const guard = migration.indexOf('CREATE OR REPLACE FUNCTION public.reject_inactive_group_edge')

    expect(preflight).toBeGreaterThan(0)
    expect(tableLock).toBeGreaterThan(preflight)
    expect(guard).toBeGreaterThan(tableLock)
    expect(migration).toContain("'auth.users'::pg_catalog.regclass")
    expect(migration).toContain("constraint_info.confdeltype = 'c'")
    expect(migration).toContain('AND NOT constraint_info.condeferrable')
    expect(migration).toContain('AND NOT constraint_info.condeferred')
    expect(migration).toContain('public.serialize_group_membership_edge()')
    expect(migration).toContain('public.sync_group_member_count()')
    expect(migration).toContain('public.moderate_group_member_atomic(uuid,uuid,uuid,text,text)')
    expect(migration).toContain('canonical group edge trigger contract drifted')
  })

  it('rejects new membership and ban edges for inactive accounts', () => {
    expect(migration).toContain('FOR KEY SHARE')
    expect(migration).toContain('profile.deleted_at IS NULL')
    expect(migration).toContain('inactive account cannot create a group membership edge')
    expect(migration).toContain('CREATE TRIGGER trg_group_members_08_reject_inactive_account')
    expect(migration).toContain('CREATE TRIGGER trg_group_bans_08_reject_inactive_account')
    expect(migration).toContain('trigger_info.tgtype = 23')
    expect(migration).toContain('trigger_info.tgqual IS NULL')
  })

  it('uses edge-profile-group lock order and removes owner membership without a leave guard', () => {
    const firstEdgeLock = migration.indexOf(
      "'group-membership:' || v_group_id::text || ':' || p_user_id::text"
    )
    const profileLock = migration.indexOf('WHERE profile.id = p_user_id\n  FOR UPDATE')
    const groupLock = migration.indexOf('ORDER BY target_group.id\n  FOR UPDATE')
    const edgeDelete = migration.indexOf('DELETE FROM public.group_members AS member')

    expect(firstEdgeLock).toBeGreaterThan(0)
    expect(profileLock).toBeGreaterThan(firstEdgeLock)
    expect(groupLock).toBeGreaterThan(profileLock)
    expect(edgeDelete).toBeGreaterThan(groupLock)
    expect(migration).toContain("member.role = 'owner'::public.member_role")
    expect(migration).toContain("'owner_memberships_removed', v_owner_memberships_removed")
    expect(migration).toContain('SET member_count = (')
    expect(migration).toContain('deleted-account group edge purge left residual authority')
  })

  it('requires an expired deletion schedule and returns a complete service response', () => {
    expect(migration).toContain("RETURN pg_catalog.jsonb_build_object('status', 'account_active')")
    expect(migration).toContain("RETURN pg_catalog.jsonb_build_object('status', 'not_scheduled')")
    expect(migration).toContain(
      "RETURN pg_catalog.jsonb_build_object('status', 'grace_period_active')"
    )
    expect(migration).toContain("'status', 'purged'")
    expect(migration).toContain("'memberships_removed', v_memberships_removed")
    expect(migration).toContain("'bans_removed', v_bans_removed")
  })

  it('keeps the RPC service-only and rejects overload-based replay drift', () => {
    expect(migration).toContain('unexpected deleted-account group purge overload exists')
    expect(migration).toContain('DO $converge_function_acls$')
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.purge_deleted_account_group_edges(uuid)'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.purge_deleted_account_group_edges(uuid)'
    )
    expect(migration).toContain('TO service_role')
    expect(migration).toContain('deleted-account group purge ACL/security contract drifted')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
