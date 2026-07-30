import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729165000_atomic_direct_message_conversation_page.sql'
  ),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic direct-message conversation-page authority', () => {
  it('is bounded, replayable, transactional, and reinstalls account barriers', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.direct_messages:atomic-conversation-page:migration'")
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

  it('publishes one exact typed service-only reader', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_direct_message_conversation_page_atomic\([\s\S]*p_conversation_id uuid,[\s\S]*p_actor_id uuid,[\s\S]*p_before_created_at timestamptz,[\s\S]*p_before_id uuid,[\s\S]*p_limit integer[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.get_direct_message_conversation_page_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.get_direct_message_conversation_page_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('ambiguous direct-message conversation-page overload exists')
    expect(migration).toContain('atomic-direct-message-conversation-page:v1:')
    expect(databaseTypes).toContain('get_direct_message_conversation_page_atomic: {')
    expect(databaseTypes).toContain('p_before_created_at: string | null')
    expect(databaseTypes).toContain('p_before_id: string | null')
  })

  it('locks admission, parents, pair, profiles, conversation, and settings in order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.get_direct_message_conversation_page_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const discovery = body!.indexOf('FROM public.conversations AS conversation')
    const admission = body!.indexOf("'account-recovery-admission:'")
    const authParents = body!.indexOf('FROM auth.users AS auth_user')
    const pair = body!.indexOf("'direct-message:pair:'")
    const profiles = body!.indexOf('FROM public.user_profiles AS profile')
    const conversation = body!.lastIndexOf('FROM public.conversations AS conversation')
    const settingsBarrier = body!.indexOf("'direct-message:settings:'")
    const settings = body!.indexOf('FROM public.conversation_members AS member_row')
    const messages = body!.indexOf('FROM public.direct_messages AS message_row')

    expect(discovery).toBeGreaterThan(0)
    expect(discovery).toBeLessThan(admission)
    expect(admission).toBeLessThan(authParents)
    expect(authParents).toBeLessThan(pair)
    expect(pair).toBeLessThan(profiles)
    expect(profiles).toBeLessThan(conversation)
    expect(conversation).toBeLessThan(settingsBarrier)
    expect(settingsBarrier).toBeLessThan(settings)
    expect(settings).toBeLessThan(messages)
    expect(body).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*ORDER BY auth_user\.id[\s\S]*FOR KEY SHARE/
    )
    expect(body).toMatch(
      /FROM public\.user_profiles AS profile[\s\S]*ORDER BY profile\.id[\s\S]*FOR SHARE/
    )
  })

  it('uses a total cursor and applies clear/delete privacy to messages and previews', () => {
    expect(migration).toContain('((p_before_created_at IS NULL) <> (p_before_id IS NULL))')
    expect(migration).toContain('p_limit NOT BETWEEN 1 AND 100')
    expect(migration).toContain('message_row.created_at < p_before_created_at')
    expect(migration).toContain('message_row.created_at = p_before_created_at')
    expect(migration).toContain('message_row.id < p_before_id')
    expect(migration).toContain('ORDER BY message_row.created_at DESC, message_row.id DESC')
    expect(migration).toContain('message_row.deleted_at IS NULL')
    expect(migration).toContain('message_row.created_at > v_cleared_before')
    expect(migration).toContain('parent_message.deleted_at IS NULL')
    expect(migration).toContain('parent_message.created_at > v_cleared_before')
    expect(migration).toContain("'next_cursor', CASE")
  })

  it('attests the exact settings and reaction uniqueness it reads', () => {
    expect(migration).toContain(
      'conversation page requires UNIQUE (conversation_id, user_id) settings'
    )
    expect(migration).toContain(
      'conversation page requires UNIQUE (message_id, user_id, emoji) reactions'
    )
    expect(migration).toContain('canonical direct-message settings lock/write contract drifted')
    expect(migration).toContain('LEFT JOIN public.direct_messages AS message_row')
    expect(migration).toContain('message_row.id IS NULL')
  })

  it('returns deterministic reaction evidence and fails closed on identity drift', () => {
    expect(migration).toContain('FROM public.message_reactions AS reaction')
    expect(migration).toContain('pg_catalog.bool_or(reaction.user_id = p_actor_id) AS mine')
    expect(migration).toContain('ORDER BY grouped_reaction.emoji')
    expect(migration).toContain("'reason', 'NOT_FOUND'")
    expect(migration).toContain("'reason', 'ACTOR_UNAVAILABLE'")
    expect(migration).toContain("'reason', 'PARTICIPANT_UNAVAILABLE'")
    expect(migration).toContain('direct-message conversation identity changed while locking; retry')
  })
})
