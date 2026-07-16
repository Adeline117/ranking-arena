import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716177000_atomic_pro_official_groups.sql'),
  'utf8'
)

function functionBody(name: string, signature: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)
  const end = migration.indexOf(`ALTER FUNCTION public.${signature}`, start)
  if (start < 0 || end < 0) throw new Error(`missing function boundary for ${name}`)
  return migration.slice(start, end)
}

const getOfficialGroup = functionBody(
  'get_pro_official_group_atomic',
  'get_pro_official_group_atomic(uuid)'
)
const joinOfficialGroup = functionBody(
  'join_pro_official_group_atomic',
  'join_pro_official_group_atomic(uuid, uuid)'
)
const leaveOfficialGroup = functionBody(
  'leave_pro_official_group_atomic',
  'leave_pro_official_group_atomic(uuid)'
)
const officialEdgeGuard = functionBody(
  'guard_pro_official_group_member_edge',
  'guard_pro_official_group_member_edge()'
)
const officialCountTrigger = functionBody(
  'sync_pro_official_member_count',
  'sync_pro_official_member_count()'
)

describe('atomic Pro official groups migration', () => {
  it('is transactional, serialized, bounded and reloads the API schema', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("hashtextextended('group-application-authority-migrations', 0)")
    expect(migration).toMatch(
      /LOCK TABLE[\s\S]*public\.groups,[\s\S]*public\.group_members,[\s\S]*public\.pro_official_groups,[\s\S]*public\.pro_official_group_members[\s\S]*IN ACCESS EXCLUSIVE MODE/
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('depends on the exact private global-Pro helper and canonical role graph', () => {
    expect(migration).toContain("'public.has_current_global_pro_entitlement(uuid)'")
    expect(migration).toContain("function_row.prorettype = 'boolean'::pg_catalog.regtype")
    expect(migration).toContain("function_row.provolatile = 's'")
    expect(migration).toContain("ARRAY['search_path=pg_catalog, pg_temp']::text[]")
    expect(migration).toContain('acl_entry.grantee <> v_postgres_oid')
    expect(migration).toContain('membership.member = v_authenticator_oid')
    expect(migration).toContain('AND NOT membership.inherit_option')
    expect(migration).toContain('AND membership.set_option')
    expect(migration).toContain('WITH RECURSIVE service_inheritors')
    expect(migration).toContain('WITH RECURSIVE service_inherits')
    expect(migration).toContain('WITH RECURSIVE browser_authority')
  })

  it('attests the unique registry and allocator keys before changing data', () => {
    expect(migration).toContain('Pro official-group unique-key authority is incompatible')
    expect(migration).toContain("attribute.attname = 'user_id'")
    expect(migration).toContain("attribute.attname = 'group_id'")
    expect(migration).toContain("attribute.attname = 'group_number'")
    expect(migration).toContain('constraint_row.convalidated')
    expect(migration).toContain('NOT constraint_row.condeferrable')
  })

  it('reconciles both edge directions and calibrates the two counters independently', () => {
    expect(migration).toContain('pg_temp.invalid_pro_official_memberships')
    expect(migration).toMatch(
      /DELETE FROM public\.group_members AS member[\s\S]*NOT EXISTS \([\s\S]*FROM public\.pro_official_group_members/
    )
    expect(migration).toMatch(
      /Repair a historical registry-only half join[\s\S]*INSERT INTO public\.group_members/
    )
    expect(migration).toMatch(
      /INSERT INTO public\.group_members \(group_id, user_id, role\)[\s\S]*'owner'::public\.member_role[\s\S]*ON CONFLICT/
    )
    expect(migration).toMatch(
      /UPDATE public\.pro_official_groups AS official_group[\s\S]*FROM public\.pro_official_group_members/
    )
    expect(migration).toMatch(
      /UPDATE public\.groups AS target_group[\s\S]*FROM public\.group_members AS member/
    )
  })

  it('uses structural edge ordering without a forgeable session marker', () => {
    expect(officialEdgeGuard).toContain('v_old_registered')
    expect(officialEdgeGuard).toContain('v_new_registered')
    expect(officialEdgeGuard).toContain('registry must be removed before its group edge')
    expect(officialEdgeGuard).toContain('managed only by its atomic RPC')
    expect(officialEdgeGuard).toContain('membership identity is immutable')
    expect(officialEdgeGuard).toContain('subscriber edge must retain the member role')
    expect(officialEdgeGuard).toMatch(
      /v_account_inactive[\s\S]*DELETE FROM public\.pro_official_group_members/
    )
    expect(migration).not.toContain('arena.pro_official_membership_edge')
    expect(migration).not.toContain('set_config(')
    expect(migration).not.toContain('current_user')
  })

  it('allocates and joins under global, user and generic-edge serialization', () => {
    const globalLock = joinOfficialGroup.indexOf("'pro-official-group-assignment'")
    const userLock = joinOfficialGroup.indexOf("'pro-official-group-user:'")
    const edgeLock = joinOfficialGroup.indexOf("'group-membership:'")
    const profileLock = joinOfficialGroup.indexOf('FROM public.user_profiles AS profile')
    const registryInsert = joinOfficialGroup.indexOf(
      'INSERT INTO public.pro_official_group_members'
    )
    const genericInsert = joinOfficialGroup.lastIndexOf('INSERT INTO public.group_members')

    expect(globalLock).toBeGreaterThan(0)
    expect(globalLock).toBeLessThan(userLock)
    expect(userLock).toBeLessThan(edgeLock)
    expect(edgeLock).toBeLessThan(profileLock)
    expect(profileLock).toBeLessThan(registryInsert)
    expect(registryInsert).toBeLessThan(genericInsert)
    expect(joinOfficialGroup).toContain('v_capacity constant integer := 500')
    expect(joinOfficialGroup).toContain('public.has_current_global_pro_entitlement(p_actor_id)')
    expect(joinOfficialGroup).toContain("'status', 'account_inactive'")
    expect(joinOfficialGroup).toContain("'status', 'pro_required'")
    expect(joinOfficialGroup).toContain("'status', 'group_full'")
  })

  it('creates group/config/owner and both subscriber edges in one RPC transaction', () => {
    expect(joinOfficialGroup).toContain('INSERT INTO public.groups')
    expect(joinOfficialGroup).toContain('INSERT INTO public.pro_official_groups')
    expect(joinOfficialGroup).toMatch(
      /INSERT INTO public\.group_members \(group_id, user_id, role\)[\s\S]*p_owner_id,[\s\S]*'owner'/
    )
    expect(joinOfficialGroup).toContain("'apply'::public.group_visibility")
    expect(joinOfficialGroup).toContain('ORDER BY official_group.group_number')
    expect(joinOfficialGroup).toContain('pg_catalog.max(official_group.group_number)')
    expect(joinOfficialGroup).toContain("'status', CASE WHEN v_was_registered")
    expect(joinOfficialGroup).toContain('v_group_member_count <> v_exact_group_member_count')
  })

  it('leaves registry first, then generic edge, and proves exact acknowledgements', () => {
    const registryDelete = leaveOfficialGroup.indexOf(
      'DELETE FROM public.pro_official_group_members'
    )
    const genericDelete = leaveOfficialGroup.indexOf('DELETE FROM public.group_members')

    expect(registryDelete).toBeGreaterThan(0)
    expect(registryDelete).toBeLessThan(genericDelete)
    expect(leaveOfficialGroup).toContain('GET DIAGNOSTICS v_deleted_count = ROW_COUNT')
    expect(leaveOfficialGroup).toContain('v_deleted_count <> 1')
    expect(leaveOfficialGroup).toContain('v_official_count <> v_registry_count')
    expect(leaveOfficialGroup).toContain('v_group_member_count <> v_exact_group_member_count')
    expect(leaveOfficialGroup).toContain("'status', 'not_member'")
    expect(leaveOfficialGroup).toContain("'status', 'left'")
  })

  it('gives each counter one canonical source and enforces the hard capacity bound', () => {
    expect(officialCountTrigger).toContain('UPDATE public.pro_official_groups')
    expect(officialCountTrigger).not.toContain('UPDATE public.groups')
    expect(officialCountTrigger).toContain('current_member_count + 1')
    expect(officialCountTrigger).toContain('current_member_count - 1')
    expect(migration).toContain('CHECK (current_member_count BETWEEN 0 AND 500)')
    expect(migration).toContain("'public.sync_group_member_count()'")
    expect(migration).toContain('trigger_row.tgtype = 13')
    expect(migration).toContain('target_group.member_count <> (')
  })

  it('publishes only three safe service-role RPCs and removes legacy write surfaces', () => {
    for (const rpc of [
      'get_pro_official_group_atomic(uuid)',
      'join_pro_official_group_atomic(uuid, uuid)',
      'leave_pro_official_group_atomic(uuid)',
    ]) {
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${rpc} TO service_role`)
    }
    for (const body of [getOfficialGroup, joinOfficialGroup, leaveOfficialGroup]) {
      expect(body).toContain('SECURITY DEFINER')
      expect(body).toContain('SET search_path = pg_catalog, pg_temp')
      expect(body).toContain("SET lock_timeout = '5s'")
      expect(body).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    }
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.%I')
    expect(migration).toContain('DROP POLICY %I ON public.%I')
    expect(migration).toContain('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('legacy Pro official-group mutation surface remains callable')
    expect(migration).toContain('incompatible Pro official-group RPC overload exists')
  })
})
