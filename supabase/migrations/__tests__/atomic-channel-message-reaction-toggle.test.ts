import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729141050_atomic_channel_message_reaction_toggle.sql'
  ),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic channel-message reaction toggle authority', () => {
  it('is bounded, replayable, and transactional', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.channel_message_reactions:atomic-toggle:migration'")
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.toggle_channel_message_reaction_atomic('
    )
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('depends on the exact channel-member serializer and reaction uniqueness', () => {
    expect(migration).toContain("'public.mutate_channel_member_atomic(uuid,uuid,uuid,text,text)'")
    expect(migration).toContain("'group-channel-owner-invariant:v1'")
    expect(migration).toContain("'channel-membership:channel:'")
    expect(migration).toContain('atomic channel-member lock contract drifted')
    expect(migration).toContain(
      'channel_message_reactions requires UNIQUE (message_id, user_id, emoji)'
    )
    expect(migration).toContain('channel-reaction service-only write boundary drifted')
  })

  it('publishes one exact service-only RPC and generated type', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.toggle_channel_message_reaction_atomic\([\s\S]*p_channel_id uuid,[\s\S]*p_message_id uuid,[\s\S]*p_actor_id uuid,[\s\S]*p_emoji text[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.toggle_channel_message_reaction_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.toggle_channel_message_reaction_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-channel-message-reaction-toggle:v1:')
    expect(databaseTypes).toContain('toggle_channel_message_reaction_atomic: {')
  })

  it('locks current membership and the bound parent before toggling', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.toggle_channel_message_reaction_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const ownerBarrier = body!.indexOf("'group-channel-owner-invariant:v1'")
    const channelBarrier = body!.indexOf("'channel-membership:channel:'")
    const observedChannel = body!.indexOf('FROM public.chat_channels AS channel_row')
    const authParents = body!.indexOf('FROM auth.users AS auth_user')
    const lockedChannel = body!.lastIndexOf('FROM public.chat_channels AS channel_row')
    const roster = body!.indexOf('FROM public.channel_members AS membership')
    const message = body!.indexOf('FROM public.channel_messages AS parent_message')
    const existing = body!.indexOf('FROM public.channel_message_reactions AS reaction')
    const insert = body!.indexOf('INSERT INTO public.channel_message_reactions')

    expect(ownerBarrier).toBeGreaterThan(0)
    expect(ownerBarrier).toBeLessThan(channelBarrier)
    expect(channelBarrier).toBeLessThan(observedChannel)
    expect(observedChannel).toBeLessThan(authParents)
    expect(authParents).toBeLessThan(lockedChannel)
    expect(lockedChannel).toBeLessThan(roster)
    expect(roster).toBeLessThan(message)
    expect(message).toBeLessThan(existing)
    expect(existing).toBeLessThan(insert)
    expect(body).toMatch(
      /FROM public\.channel_members AS membership[\s\S]*ORDER BY membership\.user_id[\s\S]*FOR UPDATE/
    )
    expect(body).toContain("'reason', 'MEMBERSHIP_NOT_FOUND'")
    expect(body).toContain("'reason', 'MESSAGE_NOT_FOUND'")
  })

  it('checks mutation rowcounts and returns bound aggregate evidence', () => {
    expect(migration).toContain('ON CONFLICT (message_id, user_id, emoji) DO NOTHING')
    expect(migration).toContain('GET DIAGNOSTICS v_changed_count = ROW_COUNT')
    expect(migration).toContain('channel reaction changed concurrently; retry')
    expect(migration).toContain("'reaction_id', v_reaction_id")
    expect(migration).toContain("'counts', v_counts")
    expect(migration).toContain("'user_emojis', pg_catalog.to_jsonb(v_user_emojis)")
    expect(migration).toContain("'message_author_id', v_message_author_id")
    expect(migration).toContain("'message_preview', pg_catalog.left(v_message_content, 100)")
  })
})
