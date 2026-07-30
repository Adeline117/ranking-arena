import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729161500_atomic_direct_message_conversation_read.sql'
  ),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic direct-message conversation-read authority', () => {
  it('is bounded, replayable, and attests the inactive-subject barrier', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.direct_messages:atomic-conversation-read:migration'")
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

  it('publishes one typed service-only monotonic RPC', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.mark_direct_message_conversation_read_atomic\([\s\S]*p_conversation_id uuid,[\s\S]*p_actor_id uuid[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.mark_direct_message_conversation_read_atomic\(uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.mark_direct_message_conversation_read_atomic\(uuid, uuid\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('ambiguous direct-message conversation-read overload exists')
    expect(databaseTypes).toContain('mark_direct_message_conversation_read_atomic: {')
    expect(databaseTypes).toContain('Args: { p_actor_id: string; p_conversation_id: string }')
  })

  it('uses account, auth-parent, pair, profile, conversation, then message order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.mark_direct_message_conversation_read_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const discovery = body!.indexOf('FROM public.conversations AS conversation')
    const account = body!.indexOf("'account-recovery-admission:'")
    const authParent = body!.indexOf('FROM auth.users AS auth_user')
    const pair = body!.indexOf("'direct-message:pair:'")
    const profile = body!.indexOf('FROM public.user_profiles AS profile')
    const conversation = body!.lastIndexOf('FROM public.conversations AS conversation')
    const messages = body!.indexOf('UPDATE public.direct_messages AS message_row')

    expect(discovery).toBeGreaterThan(0)
    expect(discovery).toBeLessThan(account)
    expect(account).toBeLessThan(authParent)
    expect(authParent).toBeLessThan(pair)
    expect(pair).toBeLessThan(profile)
    expect(profile).toBeLessThan(conversation)
    expect(conversation).toBeLessThan(messages)
    expect(body).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*ORDER BY auth_user\.id[\s\S]*FOR KEY SHARE/
    )
    expect(body).toMatch(
      /FROM public\.user_profiles AS profile[\s\S]*ORDER BY profile\.id[\s\S]*FOR SHARE/
    )
    expect(body).toMatch(
      /FROM public\.conversations AS conversation[\s\S]*FOR SHARE;[\s\S]*UPDATE public\.direct_messages/
    )
  })

  it('updates only live inbound unread state and returns database evidence', () => {
    expect(migration).toContain('message_row.conversation_id = p_conversation_id')
    expect(migration).toContain('message_row.receiver_id = p_actor_id')
    expect(migration).toContain('message_row.deleted_at IS NULL')
    expect(migration).toContain('message_row.read IS DISTINCT FROM true')
    expect(migration).toContain('message_row.read_at IS NULL')
    expect(migration).toContain('GET DIAGNOSTICS v_marked_count = ROW_COUNT')
    expect(migration).toContain("'actor_id', p_actor_id")
    expect(migration).toContain("'conversation_id', p_conversation_id")
    expect(migration).toContain("'marked_count', v_marked_count")
    expect(migration).toContain("'read_at', v_read_at")
  })

  it('fails closed for outsiders, inactive actors, parent deletion, and identity drift', () => {
    expect(migration).toContain("'reason', 'NOT_FOUND'")
    expect(migration).toContain("'reason', 'ACTOR_UNAVAILABLE'")
    expect(migration).toContain('p_actor_id NOT IN (v_initial_user1_id, v_initial_user2_id)')
    expect(migration).toContain('v_profile.is_banned IS TRUE')
    expect(migration).toContain('direct-message conversation identity changed while locking; retry')
    expect(migration).toContain('browser direct-message writes must remain revoked')
  })

  it('attests canonical pair and immutable-message dependencies', () => {
    expect(migration).toContain('canonical direct-message pair serializer authority is required')
    expect(migration).toContain('canonical direct-message immutable-field guard is required')
    expect(migration).toContain("'trg_serialize_dm_message_pair'")
    expect(migration).toContain("'trg_guard_dm_immutable_fields'")
    expect(migration).toContain("'ARRAY[''read'', ''read_at'', ''deleted_at'']'")
    expect(migration).toContain(
      'direct-message conversation-read found non-canonical participant data'
    )
  })
})
