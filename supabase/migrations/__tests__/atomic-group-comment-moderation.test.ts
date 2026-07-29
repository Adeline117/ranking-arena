import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729145000_atomic_group_comment_moderation.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic group comment moderation authority', () => {
  it('is bounded, replayable, transactional, and reloads PostgREST', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.comments:atomic-group-moderation:migration'")
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.moderate_group_comment_atomic(')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('requires canonical membership and comment mutation authorities', () => {
    expect(migration).toContain("'public.serialize_group_membership_edge()'")
    expect(migration).toContain("'trg_group_members_05_serialize_edge'")
    expect(migration).toContain("'public.set_group_member_role_atomic(uuid,uuid,uuid,text)'")
    expect(migration).toContain("'public.moderate_comment(uuid,uuid,text,text)'")
    expect(migration).toContain('atomic group role lock contract drifted')
    expect(migration).toContain('canonical comment moderation contract drifted')
    expect(migration).toContain('group comment moderation browser write boundary drifted')
  })

  it('publishes one exact service-only RPC and generated type', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.moderate_group_comment_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_group_id uuid,[\s\S]*p_comment_id uuid,[\s\S]*p_reason text[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.moderate_group_comment_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.moderate_group_comment_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-group-comment-moderation:v1:')
    expect(databaseTypes).toContain('moderate_group_comment_atomic: {')
  })

  it('serializes current authority before the irreversible comment mutation', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.moderate_group_comment_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const auth = body!.indexOf('FROM auth.users AS auth_user')
    const edge = body!.indexOf('pg_advisory_xact_lock(')
    const profile = body!.indexOf('FROM public.user_profiles AS profile')
    const post = body!.indexOf('FROM public.posts AS target_post')
    const group = body!.indexOf('FROM public.groups AS target_group')
    const member = body!.indexOf('FROM public.group_members AS member')
    const lockedComment = body!.indexOf('PERFORM target_comment.id')
    const moderate = body!.indexOf('FROM public.moderate_comment(')
    const audit = body!.indexOf('INSERT INTO public.group_audit_log')

    expect(auth).toBeGreaterThan(0)
    expect(auth).toBeLessThan(edge)
    expect(edge).toBeLessThan(profile)
    expect(profile).toBeLessThan(post)
    expect(post).toBeLessThan(group)
    expect(group).toBeLessThan(member)
    expect(member).toBeLessThan(lockedComment)
    expect(lockedComment).toBeLessThan(moderate)
    expect(moderate).toBeLessThan(audit)
    expect(body).toMatch(
      /FROM public\.group_members AS member[\s\S]*FOR UPDATE;[\s\S]*v_actor_is_member := FOUND/
    )
  })

  it('binds group identity, rejects dissolution, and records exact deletion evidence', () => {
    expect(migration).toContain("'reason', 'GROUP_DISSOLVED'")
    expect(migration).toContain("v_actor_role NOT IN ('owner', 'admin')")
    expect(migration).toContain('v_post.group_id IS DISTINCT FROM p_group_id')
    expect(migration).toContain("'reason', 'COMMENT_NOT_IN_GROUP'")
    expect(migration).toContain("'hard_delete'")
    expect(migration).toContain("'delete_comment'")
    expect(migration).toContain("'affected_count', v_affected_count")
    expect(migration).toContain("'comment_count', v_comment_count")
    expect(migration).toContain("'audit_id', v_audit_id")
    expect(migration).toContain('remaining_comment.id = p_comment_id')
  })
})
