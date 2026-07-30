import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729163000_atomic_direct_message_conversation_settings.sql'
  ),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic direct-message conversation-settings authority', () => {
  it('is bounded, replay-safe, and reinstalls the inactive-subject barrier', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.conversation_members:atomic-settings:migration'")
    expect(migration).toContain('DO $preflight$')
    expect(migration).toContain('DO $ensure_exact_unique_key$')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain(
      'SELECT public.install_active_authenticated_subject_mutation_barriers()'
    )
    expect(migration).toContain(
      'SELECT public.assert_active_authenticated_subject_mutation_barriers()'
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('publishes one typed service-only RPC and removes direct writes', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.mutate_direct_message_conversation_settings_atomic\([\s\S]*p_conversation_id uuid,[\s\S]*p_actor_id uuid,[\s\S]*p_clear_history boolean[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.mutate_direct_message_conversation_settings_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.mutate_direct_message_conversation_settings_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('ambiguous direct-message settings overload exists')
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    expect(migration).toContain("policy.polcmd IN ('*', 'a', 'w', 'd')")
    expect(databaseTypes).toContain('mutate_direct_message_conversation_settings_atomic: {')
    expect(databaseTypes).toContain('p_clear_history: boolean')
    expect(databaseTypes).toContain('p_remark_present: boolean')
  })

  it('uses account, auth, pair, profile, conversation, then settings order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.mutate_direct_message_conversation_settings_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const discovery = body!.indexOf('FROM public.conversations AS conversation')
    const account = body!.indexOf("'account-recovery-admission:'")
    const authParent = body!.indexOf('FROM auth.users AS auth_user')
    const pair = body!.indexOf("'direct-message:pair:'")
    const profile = body!.indexOf('FROM public.user_profiles AS profile')
    const conversation = body!.lastIndexOf('FROM public.conversations AS conversation')
    const settings = body!.indexOf("'direct-message:settings:'")

    expect(discovery).toBeGreaterThan(0)
    expect(discovery).toBeLessThan(account)
    expect(account).toBeLessThan(authParent)
    expect(authParent).toBeLessThan(pair)
    expect(pair).toBeLessThan(profile)
    expect(profile).toBeLessThan(conversation)
    expect(conversation).toBeLessThan(settings)
    expect(body).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*ORDER BY auth_user\.id[\s\S]*FOR KEY SHARE/
    )
    expect(body).toMatch(
      /FROM public\.user_profiles AS profile[\s\S]*ORDER BY profile\.id[\s\S]*FOR UPDATE/
    )
    expect(body).toMatch(/FROM public\.conversations AS conversation[\s\S]*FOR SHARE;/)
  })

  it('strictly validates fields and makes clear-history monotonic', () => {
    expect(migration).toContain('(p_remark_present IS FALSE AND p_remark IS NOT NULL)')
    expect(migration).toContain('(p_is_muted_present IS DISTINCT FROM (p_is_muted IS NOT NULL))')
    expect(migration).toContain('pg_catalog.char_length(v_remark) > 50')
    expect(migration).toContain("'reason', 'INVALID'")
    expect(migration).toContain('member_row.cleared_before < v_now')
    expect(migration).toContain("'applied_fields', pg_catalog.to_jsonb(v_applied_fields)")
    expect(migration).not.toContain('p_cleared_before')
  })

  it('uses the canonical block authority and persists only its projection', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.mutate_direct_message_conversation_settings_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()
    expect(migration).toContain('public.mutate_user_block_atomic(')
    expect(migration).toContain("CASE WHEN p_is_blocked THEN 'block' ELSE 'unblock' END")
    expect(migration).toContain("v_block_status NOT IN ('blocked', 'already_blocked')")
    expect(migration).toContain("v_block_status IN ('blocked', 'unblocked')")
    expect(migration).toContain('FROM public.blocked_users AS block_edge')
    expect(migration).toContain('canonical user-block edge disagrees with acknowledgement')
    expect(migration).toContain('is_blocked = v_effective_is_blocked')
    expect(body).not.toContain('INSERT INTO public.blocked_users')
  })

  it('fails closed for outsiders, deleted or banned identities, and parent races', () => {
    expect(migration).toContain("'reason', 'NOT_FOUND'")
    expect(migration).toContain("'reason', 'ACTOR_UNAVAILABLE'")
    expect(migration).toContain("'reason', 'PARTICIPANT_UNAVAILABLE'")
    expect(migration).toContain('p_actor_id NOT IN (v_initial_user1_id, v_initial_user2_id)')
    expect(migration).toContain('v_profile.deleted_at IS NULL')
    expect(migration).toContain('v_profile.banned_at IS NULL')
    expect(migration).toContain('v_profile.is_banned IS TRUE')
    expect(migration).toContain('direct-message conversation identity changed while locking; retry')
  })
})
