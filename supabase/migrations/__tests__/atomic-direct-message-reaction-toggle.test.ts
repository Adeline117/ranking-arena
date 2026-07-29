import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729158000_atomic_direct_message_reaction_toggle.sql'
  ),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic direct-message reaction toggle authority', () => {
  it('is bounded, replayable, and covered by the inactive-subject installer', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.message_reactions:atomic-toggle:migration'")
    expect(migration).toContain('DO $ledger_attestation$')
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

  it('publishes one service-only operation-id RPC and private durable ledger', () => {
    expect(migration).toContain('CREATE TABLE public.direct_message_reaction_operations')
    expect(migration).toContain('PRIMARY KEY (operation_id)')
    expect(migration).toContain('intent_fingerprint')
    expect(migration).toContain("AND NOT result ? 'applied'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON TABLE public\.direct_message_reaction_operations[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.toggle_direct_message_reaction_atomic\([\s\S]*p_operation_id uuid,[\s\S]*p_message_id uuid,[\s\S]*p_actor_id uuid,[\s\S]*p_emoji text[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain("'direct-message-reaction-operation:' || p_operation_id::text")
    expect(migration).toContain("'reason', 'OPERATION_CONFLICT'")
    expect(migration).toContain("'applied', false")
    expect(migration).toContain("'applied', true")
    expect(databaseTypes).toContain('direct_message_reaction_operations: {')
    expect(databaseTypes).toContain('toggle_direct_message_reaction_atomic: {')
    expect(databaseTypes).toContain('p_operation_id: string')
  })

  it('uses the canonical account, pair, parent, and child lock order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.toggle_direct_message_reaction_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const operationLock = body!.indexOf("'direct-message-reaction-operation:'")
    const initialMessage = body!.indexOf('FROM public.direct_messages AS message_row')
    const accountLock = body!.indexOf("'account-recovery-admission:'")
    const authParents = body!.indexOf('FROM auth.users AS auth_user')
    const pairLock = body!.indexOf("'direct-message:pair:'")
    const profiles = body!.indexOf('FROM public.user_profiles AS profile')
    const conversation = body!.indexOf('FROM public.conversations AS conversation')
    const lockedMessage = body!.lastIndexOf('FROM public.direct_messages AS message_row')
    const blockEdge = body!.indexOf('FROM public.blocked_users AS block_edge')
    const reaction = body!.indexOf('FROM public.message_reactions AS reaction')

    expect(operationLock).toBeGreaterThan(0)
    expect(operationLock).toBeLessThan(initialMessage)
    expect(initialMessage).toBeLessThan(accountLock)
    expect(accountLock).toBeLessThan(authParents)
    expect(authParents).toBeLessThan(pairLock)
    expect(pairLock).toBeLessThan(profiles)
    expect(profiles).toBeLessThan(conversation)
    expect(conversation).toBeLessThan(lockedMessage)
    expect(lockedMessage).toBeLessThan(blockEdge)
    expect(blockEdge).toBeLessThan(reaction)
    expect(body).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*ORDER BY auth_user\.id[\s\S]*FOR KEY SHARE/
    )
    expect(body).toMatch(
      /FROM public\.user_profiles AS profile[\s\S]*ORDER BY profile\.id[\s\S]*FOR SHARE/
    )
    expect(body).toContain("'reason', 'ACTOR_UNAVAILABLE'")
    expect(body).toContain("'reason', 'PARTICIPANT_UNAVAILABLE'")
    expect(body).toContain("'reason', 'MESSAGE_NOT_FOUND'")
    expect(body).toContain("'reason', 'FORBIDDEN'")
    expect(body).toContain("'reason', 'BLOCKED'")
  })

  it('checks unique mutation evidence and returns only transactional aggregates', () => {
    expect(migration).toContain('message_reactions requires UNIQUE (message_id, user_id, emoji)')
    expect(migration).toContain('ON CONFLICT (message_id, user_id, emoji) DO NOTHING')
    expect(migration).toContain('GET DIAGNOSTICS v_changed_count = ROW_COUNT')
    expect(migration).toContain('direct-message reaction changed concurrently; retry')
    expect(migration).toContain("'counts', v_counts")
    expect(migration).toContain("'user_emojis', pg_catalog.to_jsonb(v_user_emojis)")
    expect(migration).toContain("'notification_created', v_notification_created")
    expect(migration).toContain('INSERT INTO public.notifications')
    expect(migration).toContain('INSERT INTO public.direct_message_reaction_operations')
  })

  it('revokes browser writes and converges exact RPC ACLs', () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE[\s\S]*ON TABLE public\.message_reactions[\s\S]*FROM PUBLIC, anon, authenticated/
    )
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.toggle_direct_message_reaction_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.toggle_direct_message_reaction_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('direct-message reaction service-only write boundary drifted')
    expect(migration).toContain('atomic-direct-message-reaction-toggle:v1:')
  })
})
