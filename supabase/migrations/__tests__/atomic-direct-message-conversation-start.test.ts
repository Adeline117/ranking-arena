import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729159000_atomic_direct_message_conversation_start.sql'
  ),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic direct-message conversation-start authority', () => {
  it('is bounded, replayable, and attests the global inactive-subject barrier', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.conversations:atomic-direct-message-start:migration'")
    expect(migration).toContain('DO $preflight$')
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

  it('publishes one typed service-only RPC', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.start_direct_message_conversation_atomic\([\s\S]*p_sender_id uuid,[\s\S]*p_receiver_id uuid[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.start_direct_message_conversation_atomic\(uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.start_direct_message_conversation_atomic\(uuid, uuid\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('ambiguous direct-message conversation-start overload exists')
    expect(databaseTypes).toContain('start_direct_message_conversation_atomic: {')
    expect(databaseTypes).toContain('Args: { p_receiver_id: string; p_sender_id: string }')
  })

  it('takes the canonical account, auth-parent, pair, profile, and conversation order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.start_direct_message_conversation_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const account = body!.indexOf("'account-recovery-admission:'")
    const authParent = body!.indexOf('FROM auth.users AS auth_user')
    const pair = body!.indexOf("'direct-message:pair:'")
    const profile = body!.indexOf('FROM public.user_profiles AS profile')
    const permission = body!.indexOf('public.check_dm_permission(')
    const conversation = body!.indexOf('FROM public.conversations AS conversation')

    expect(account).toBeGreaterThan(0)
    expect(account).toBeLessThan(authParent)
    expect(authParent).toBeLessThan(pair)
    expect(pair).toBeLessThan(profile)
    expect(profile).toBeLessThan(permission)
    expect(permission).toBeLessThan(conversation)
    expect(body).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*ORDER BY auth_user\.id[\s\S]*FOR KEY SHARE/
    )
    expect(body).toMatch(
      /FROM public\.user_profiles AS profile[\s\S]*ORDER BY profile\.id[\s\S]*FOR SHARE/
    )
    expect(body).toContain("'reason', 'SENDER_UNAVAILABLE'")
    expect(body).toContain("'reason', 'USER_NOT_FOUND'")
  })

  it('strictly normalizes the canonical permission union before any insert', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.start_direct_message_conversation_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()
    expect(body).toContain('v_permission - ARRAY[')
    expect(body).toContain("'receiver_replied', true")
    expect(body).toContain("'is_mutual', true")
    expect(body).toContain("v_reason IN (\n       'BLOCKED',")
    expect(body).toContain("v_reason = 'LIMIT_REACHED'")
    expect(body).toContain('check_dm_permission returned an invalid contract')
    expect(body!.indexOf('public.check_dm_permission(')).toBeLessThan(
      body!.indexOf('INSERT INTO public.conversations')
    )
  })

  it('returns an exact identity-bound acknowledgement and never creates for ordinary denial', () => {
    expect(migration).toContain("'sender_id', p_sender_id")
    expect(migration).toContain("'receiver_id', p_receiver_id")
    expect(migration).toContain("'conversation_id', v_conversation_id")
    expect(migration).toContain("'receiver_handle', v_receiver_handle")
    expect(migration).toContain("'can_message', v_allowed")
    expect(migration).toContain("'is_mutual_follow', v_is_mutual")
    expect(migration).toContain("'message_limit', v_message_limit")
    expect(migration).toContain("'created', v_created")
    expect(migration).toContain('Never manufacture an empty relationship merely to report a denial')
    expect(migration).toContain('ON CONFLICT (user1_id, user2_id) DO NOTHING')
    expect(migration).toContain('message limit has no canonical conversation')
  })

  it('attests dependency behavior, canonical pair shape, and the serializer triggers', () => {
    expect(migration).toContain('canonical service-only check_dm_permission authority is required')
    expect(migration).toContain('canonical direct-message pair serializer authority is required')
    expect(migration).toContain(
      'conversations requires canonical non-deferrable ordered-pair uniqueness'
    )
    expect(migration).toContain("'trg_serialize_dm_block_pair'")
    expect(migration).toContain("'trg_serialize_dm_follow_pair'")
    expect(migration).toContain("'trg_serialize_dm_message_pair'")
    expect(migration).toContain("pg_catalog.strpos(v_permission_source, 'LIMIT_REACHED')")
    expect(migration).toContain("pg_catalog.strpos(v_pair_source, 'direct-message:pair:')")
  })
})
