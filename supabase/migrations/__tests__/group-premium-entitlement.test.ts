import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716176100_group_premium_entitlement.sql'),
  'utf8'
)

describe('current premium-group entitlement migration', () => {
  it('defines one current global-Pro and group entitlement contract', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.has_current_global_pro_entitlement'
    )
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.has_current_group_entitlement')
    expect(migration).toContain("subscription.status IN ('active', 'trialing')")
    expect(migration).toContain('subscription.current_period_end')
    expect(migration).toContain('profile_entitlement.pro_expires_at')
    expect(migration).toContain("group_pass.status IN ('active', 'trialing')")
    expect(migration).toContain('group_pass.expires_at')
    expect(migration).toContain("'owner'::public.member_role")
    expect(migration).toContain("'admin'::public.member_role")
    expect(migration.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(8)
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.can_actor_read_post_fields')
    expect(migration).toContain('public.current_user_can_read_post_with_current_entitlement(id)')
  })

  it('forward-patches only the singular current predicate in every entry point', () => {
    for (const signature of [
      'mutate_group_membership_atomic(uuid,uuid,text,boolean)',
      'redeem_group_invite_atomic(uuid,uuid,text,boolean)',
      'mutate_group_join_request_atomic(uuid,uuid,text,text,boolean)',
      'inspect_group_invite_atomic(uuid,uuid,text,boolean)',
    ]) {
      expect(migration).toContain(`public.${signature}`)
    }
    expect(migration).toContain('pg_catalog.pg_get_functiondef')
    expect(migration).toContain('membership entry-point predicate is not singular')
    expect(migration).toContain('NOT public.has_current_group_entitlement(p_actor_id, p_group_id)')
    expect(migration).toContain("COALESCE(v_profile.subscription_tier, ''free'') <> ''pro''")
  })

  it('fail-closes premium post reads and writes without an author read bypass', () => {
    expect(migration).toContain('CREATE POLICY posts_group_premium_read_entitlement')
    expect(migration).toContain('CREATE POLICY posts_group_premium_insert_entitlement')
    expect(migration).toContain('CREATE POLICY posts_group_premium_update_entitlement')
    expect(migration.match(/AS RESTRICTIVE/g)).toHaveLength(3)
    expect(migration).toContain(
      'USING (public.current_user_can_read_post_with_current_entitlement(id))'
    )
    expect(migration).not.toContain('OR author_id = (SELECT auth.uid())')
    expect(migration).not.toContain('posts_group_premium_delete_entitlement')
  })

  it('guards admin-client publication without blocking delete or background fields', () => {
    const publishGuard = migration.match(
      /CREATE OR REPLACE FUNCTION public\.enforce_current_group_post_publish\(\)[\s\S]*?\n\$function\$;/
    )?.[0]

    expect(publishGuard).toBeDefined()
    expect(publishGuard).toContain('NEW.author_id IS DISTINCT FROM OLD.author_id')
    expect(publishGuard).toContain('NEW.group_id IS DISTINCT FROM OLD.group_id')
    expect(publishGuard).toContain('v_actor_id := OLD.author_id')
    expect(publishGuard).toContain('v_group_id := OLD.group_id')
    for (const field of [
      'title',
      'content',
      'visibility',
      'poll_enabled',
      'images',
      'is_sensitive',
      'content_warning',
    ]) {
      expect(publishGuard).toContain(`NEW.${field} IS NOT DISTINCT FROM OLD.${field}`)
    }
    expect(publishGuard).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(publishGuard).toContain("'group-membership:'")
    expect(publishGuard).toContain('public.has_current_group_entitlement(v_actor_id, v_group_id)')
    expect(publishGuard).not.toContain("TG_OP = 'DELETE'")
    expect(migration).toContain('CREATE TRIGGER trg_posts_15_current_group_publish')
    expect(migration).toContain('BEFORE INSERT OR UPDATE')
    expect(migration).toContain('group post publish trigger contract drifted')
  })

  it('keeps private helpers private and exposes actor-bound wrappers only', () => {
    expect(migration).toContain('DO $converge_function_authority$')
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.current_user_has_current_group_entitlement(uuid)'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.service_actor_has_current_group_entitlement('
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.service_actor_has_current_global_pro_entitlement(uuid)'
    )
    expect(migration).toContain('premium entitlement function ACL is not exact')
    expect(migration).toContain('group premium entitlement service-role graph is unsafe')
    expect(migration).toContain('service post reader composition drifted')
    expect(migration).toContain('following wrapper/root entitlement composition drifted')
  })

  it('is an idempotent database-only migration', () => {
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).not.toMatch(/(?:jsx|tsx|className|grid-template|tailwind)/i)
  })
})
