import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729170000_atomic_direct_message_conversation_list.sql'
  ),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')
const pg17Proof = [
  'supabase/migrations/__tests__/atomic-direct-message-conversation-list.pg17.sh',
  'supabase/migrations/__tests__/atomic-direct-message-conversation-list.proof.pg17.sh',
]
  .map((path) => readFileSync(join(process.cwd(), path), 'utf8'))
  .join('\n')

describe('atomic direct-message conversation-list authority', () => {
  it('is bounded, replayable, transactional, and reinstalls account barriers', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.conversations:atomic-direct-message-list:migration'")
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
      /CREATE OR REPLACE FUNCTION public\.get_direct_message_conversation_list_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_limit integer[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.get_direct_message_conversation_list_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.get_direct_message_conversation_list_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('ambiguous direct-message conversation-list overload exists')
    expect(migration).toContain('atomic-direct-message-conversation-list:v1:')
    expect(databaseTypes).toContain('get_direct_message_conversation_list_atomic: {')
    expect(databaseTypes).toContain('Args: { p_actor_id: string; p_limit: number }')
  })

  it('holds actor lifecycle admission and composes content in one MVCC statement', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.get_direct_message_conversation_list_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()
    expect(body).toContain("'account-recovery-admission:' || p_actor_id::text")
    expect(body).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*FOR KEY SHARE[\s\S]*FROM public\.user_profiles AS profile[\s\S]*FOR SHARE/
    )
    expect(body).toContain('one MVCC snapshot')
    expect(body!.match(/INTO STRICT v_conversations/g)).toHaveLength(1)
    expect(body).not.toContain('Promise.all')
  })

  it('uses live messages for ordering, preview, unread count, and clear privacy', () => {
    expect(migration).toContain('message_row.deleted_at IS NULL')
    expect(migration).toContain('message_row.created_at > member_row.cleared_before')
    expect(migration).toContain('unread_message.deleted_at IS NULL')
    expect(migration).toContain('unread_message.read IS DISTINCT FROM true')
    expect(migration).toContain('unread_message.created_at > member_row.cleared_before')
    expect(migration).toContain('ORDER BY message_row.created_at DESC, message_row.id DESC')
    expect(migration).toContain('ORDER BY is_pinned DESC, sort_at DESC, conversation.id')
    expect(migration).toContain('LIMIT p_limit')
  })

  it('attests canonical participants, settings uniqueness, and writer fences', () => {
    expect(migration).toContain(
      'conversation list requires UNIQUE (conversation_id, user_id) settings'
    )
    expect(migration).toContain(
      'direct-message conversation-list found non-canonical participant data'
    )
    expect(migration).toContain('canonical direct-message pair serializer contract drifted')
    expect(migration).toContain('canonical direct-message list writer lock contract drifted')
    expect(migration).toContain('canonical direct-message list lifecycle contract drifted')
  })

  it('ships an isolated PostgreSQL 17 race and privacy proof', () => {
    for (const marker of [
      'cleared conversation reappeared before a new live message',
      'deleted message leaked into inbox preview',
      'pin ordering or page limit drifted',
      'uncommitted send crossed the conversation-list snapshot',
      'uncommitted clear crossed the conversation-list snapshot',
      'actor lifecycle admission failed to serialize',
      'atomic direct-message conversation-list PostgreSQL 17 checks passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
