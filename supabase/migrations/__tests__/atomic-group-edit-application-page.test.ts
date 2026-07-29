import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729155000_atomic_group_edit_application_page.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic group edit-application page authority', () => {
  it('is bounded, replayable, and transactional', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.group_edit_applications:atomic-page:migration'")
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.get_group_edit_applications_page_atomic('
    )
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('publishes one exact service-only RPC and generated type', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_group_edit_applications_page_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_group_id uuid,[\s\S]*p_before_created_at timestamptz,[\s\S]*p_before_id uuid,[\s\S]*p_limit integer[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.get_group_edit_applications_page_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.get_group_edit_applications_page_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-group-edit-application-page:v1:')
    expect(databaseTypes).toContain('get_group_edit_applications_page_atomic: {')
  })

  it('locks current owner authority before reading private proposals', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.get_group_edit_applications_page_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const authParent = body!.indexOf('FROM auth.users AS auth_user')
    const profile = body!.indexOf('FROM public.user_profiles AS profile')
    const group = body!.indexOf('FROM public.groups AS target_group')
    const membership = body!.indexOf('FROM public.group_members AS member')
    const applications = body!.indexOf('FROM public.group_edit_applications AS application')

    expect(authParent).toBeGreaterThan(0)
    expect(authParent).toBeLessThan(profile)
    expect(profile).toBeLessThan(group)
    expect(group).toBeLessThan(membership)
    expect(membership).toBeLessThan(applications)
    expect(body).toMatch(/FROM auth\.users AS auth_user[\s\S]*FOR SHARE/)
    expect(body).toMatch(/FROM public\.user_profiles AS profile[\s\S]*FOR SHARE/)
    expect(body).toMatch(/FROM public\.groups AS target_group[\s\S]*FOR SHARE/)
    expect(body).toMatch(/FROM public\.group_members AS member[\s\S]*FOR SHARE/)
    expect(body).toContain("v_actor_role = 'owner'")
    expect(body).toContain("v_actor_role = 'admin' AND v_group.created_by = p_actor_id")
  })

  it('returns a stable bounded application allowlist', () => {
    expect(migration).toContain('p_limit NOT BETWEEN 1 AND 100')
    expect(migration).toContain('(p_before_created_at IS NULL) <> (p_before_id IS NULL)')
    expect(migration).toContain('ORDER BY application.created_at DESC, application.id DESC')
    expect(migration).toContain('LIMIT p_limit + 1')
    expect(migration).toContain("'applications', v_applications")
    expect(migration).toContain("'has_more', v_has_more")
    expect(migration).not.toContain("'reviewed_by', numbered.reviewed_by")
  })
})
