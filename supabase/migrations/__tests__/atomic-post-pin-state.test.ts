import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729182500_atomic_post_pin_state.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic post pin state authority', () => {
  it('is bounded, replayable, transactional, and reloads PostgREST', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.posts:atomic-post-pin-state:migration'")
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.set_post_pin_state_atomic(')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('publishes one exact service-only function and generated type', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.set_post_pin_state_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_post_id uuid,[\s\S]*p_is_pinned boolean[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.set_post_pin_state_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.set_post_pin_state_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-post-pin-state:v1:')
    expect(databaseTypes).toContain('set_post_pin_state_atomic: {')
  })

  it('locks the logical scope and canonical audience before any pin mutation', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.set_post_pin_state_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const scopeAdvisory = body!.indexOf("'post-pin:'")
    const actor = body!.indexOf('FROM auth.users AS auth_user')
    const membershipAdvisory = body!.indexOf("'group-membership:'")
    const profile = body!.indexOf('FROM public.user_profiles AS profile')
    const audience = body!.indexOf('public.lock_actor_can_interact_with_post(')
    const scopeRows = body!.indexOf('FROM public.posts AS scoped_post')
    const unpin = body!.indexOf('UPDATE public.posts AS other_post')
    const target = body!.indexOf('UPDATE public.posts AS target_post')

    expect(scopeAdvisory).toBeGreaterThan(0)
    expect(scopeAdvisory).toBeLessThan(actor)
    expect(actor).toBeLessThan(membershipAdvisory)
    expect(membershipAdvisory).toBeLessThan(profile)
    expect(profile).toBeLessThan(audience)
    expect(audience).toBeLessThan(scopeRows)
    expect(scopeRows).toBeLessThan(unpin)
    expect(scopeRows).toBeLessThan(target)
    expect(body).toContain('ORDER BY scoped_post.id')
    expect(body).toContain('FOR UPDATE')
  })

  it('implements explicit set semantics, duplicate healing, and exact evidence', () => {
    expect(migration).toContain('v_post.is_pinned IS NOT DISTINCT FROM p_is_pinned')
    expect(migration).toContain('v_other_pinned_count = 0')
    expect(migration).toContain('SET is_pinned = false')
    expect(migration).toContain('SET is_pinned = true')
    expect(migration).toContain("'already_set', v_already_set")
    expect(migration).toContain("'unpinned_count', v_unpinned_count")
    expect(migration).toContain("'scope_type', v_scope_type")
    expect(migration).toContain("'scope_id', v_scope_id")
    expect(migration).toContain('post pin state acknowledgement is invalid')
  })

  it('requires an active actor, current audience, and author-or-manager authority', () => {
    expect(migration).toContain("'reason', 'ACTOR_UNAVAILABLE'")
    expect(migration).toContain('public.lock_actor_can_interact_with_post(p_post_id, p_actor_id)')
    expect(migration).toContain('v_post.author_id IS DISTINCT FROM p_actor_id')
    expect(migration).toContain("v_actor_role NOT IN ('owner', 'admin')")
    expect(migration).toContain("'reason', 'PERMISSION_DENIED'")
    expect(migration).toContain("'reason', 'POST_NOT_FOUND'")
  })
})
