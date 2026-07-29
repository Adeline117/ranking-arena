import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729142149_atomic_group_member_role_change.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic group member-role change authority', () => {
  it('is bounded, replayable, and transactional', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.group_members:atomic-role-change:migration'")
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.set_group_member_role_atomic(')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('depends on canonical membership-edge and moderation locks', () => {
    expect(migration).toContain("'public.serialize_group_membership_edge()'")
    expect(migration).toContain("'public.moderate_group_member_atomic(uuid,uuid,uuid,text,text)'")
    expect(migration).toContain("'trg_group_members_05_serialize_edge'")
    expect(migration).toContain("'group-membership:'")
    expect(migration).toContain('group membership edge serializer contract drifted')
    expect(migration).toContain('atomic group moderation lock contract drifted')
    expect(migration).toContain('group member-role service-only write boundary drifted')
  })

  it('publishes one exact service-only RPC and generated type', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.set_group_member_role_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_group_id uuid,[\s\S]*p_target_id uuid,[\s\S]*p_role text[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.set_group_member_role_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.set_group_member_role_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-group-member-role-change:v1:')
    expect(databaseTypes).toContain('set_group_member_role_atomic: {')
  })

  it('locks Auth parents, sorted edges, profiles, group, and memberships in order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.set_group_member_role_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const auth = body!.indexOf('FROM auth.users AS auth_user')
    const firstEdge = body!.indexOf('pg_advisory_xact_lock(')
    const profiles = body!.indexOf('FROM public.user_profiles AS profile')
    const group = body!.indexOf('FROM public.groups AS target_group')
    const members = body!.indexOf('FROM public.group_members AS member')
    const update = body!.indexOf('UPDATE public.group_members AS member')
    const audit = body!.indexOf('INSERT INTO public.group_audit_log')

    expect(auth).toBeGreaterThan(0)
    expect(auth).toBeLessThan(firstEdge)
    expect(firstEdge).toBeLessThan(profiles)
    expect(profiles).toBeLessThan(group)
    expect(group).toBeLessThan(members)
    expect(members).toBeLessThan(update)
    expect(update).toBeLessThan(audit)
    expect(body).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*ORDER BY auth_user\.id[\s\S]*FOR SHARE/
    )
    expect(body).toMatch(
      /FROM public\.group_members AS member[\s\S]*ORDER BY member\.user_id[\s\S]*FOR UPDATE/
    )
  })

  it('requires the canonical owner, preserves owner role, and returns audit evidence', () => {
    expect(migration).toContain("v_actor_role IS DISTINCT FROM 'owner'")
    expect(migration).toContain('v_group.created_by IS DISTINCT FROM p_actor_id')
    expect(migration).toContain("v_target_role = 'owner'")
    expect(migration).toContain("p_role NOT IN ('admin', 'member')")
    expect(migration).toContain('GET DIAGNOSTICS v_changed_count = ROW_COUNT')
    expect(migration).toContain("CASE WHEN p_role = 'admin' THEN 'promote' ELSE 'demote' END")
    expect(migration).toContain("'previous_role', v_target_role")
    expect(migration).toContain("'changed', true")
    expect(migration).toContain("'audit_id', v_audit_id")
  })
})
