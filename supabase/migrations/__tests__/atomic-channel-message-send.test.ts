import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729135645_atomic_channel_message_send.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic channel-message send authority', () => {
  it('is bounded, replayable, and transactional', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.channel_messages:atomic-send:migration'")
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.send_channel_message_atomic(')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('depends on the exact channel-member serializer and required storage shape', () => {
    expect(migration).toContain("'public.mutate_channel_member_atomic(uuid,uuid,uuid,text,text)'")
    expect(migration).toContain("'group-channel-owner-invariant:v1'")
    expect(migration).toContain("'channel-membership:channel:'")
    expect(migration).toContain('atomic channel-member lock contract drifted')
    expect(migration).toContain('channel_messages row shape drifted')
    expect(migration).toContain('channel_message_reads requires UNIQUE (channel_id, user_id)')
    expect(migration).toContain('channel-message service-only write boundary drifted')
  })

  it('hardens the summary trigger for a fixed search path', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.update_channel_last_message\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*UPDATE public\.chat_channels/
    )
    expect(migration).toMatch(
      /CREATE TRIGGER trg_channel_message_update[\s\S]*AFTER INSERT[\s\S]*ON public\.channel_messages[\s\S]*EXECUTE FUNCTION public\.update_channel_last_message\(\)/
    )
    expect(migration).toContain('channel-last-message-summary:v1:')
    expect(migration).toContain('channel last-message trigger attestation failed')
  })

  it('publishes one exact service-only RPC and generated type', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.send_channel_message_atomic\([\s\S]*p_channel_id uuid,[\s\S]*p_sender_id uuid,[\s\S]*p_content text,[\s\S]*p_media_url text DEFAULT NULL,[\s\S]*p_media_type text DEFAULT NULL,[\s\S]*p_media_name text DEFAULT NULL,[\s\S]*p_reply_to_id uuid DEFAULT NULL[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.send_channel_message_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.send_channel_message_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-channel-message-send:v1:')
    expect(databaseTypes).toContain('send_channel_message_atomic: {')
  })

  it('locks current membership before validating reply and applying both writes', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.send_channel_message_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const ownerBarrier = body!.indexOf("'group-channel-owner-invariant:v1'")
    const channelBarrier = body!.indexOf("'channel-membership:channel:'")
    const observedChannel = body!.indexOf('FROM public.chat_channels AS channel_row')
    const authParents = body!.indexOf('FROM auth.users AS auth_user')
    const lockedChannel = body!.lastIndexOf('FROM public.chat_channels AS channel_row')
    const roster = body!.indexOf('FROM public.channel_members AS membership')
    const reply = body!.indexOf('FROM public.channel_messages AS parent_message')
    const insert = body!.indexOf('INSERT INTO public.channel_messages')
    const readMarker = body!.indexOf('INSERT INTO public.channel_message_reads')

    expect(ownerBarrier).toBeGreaterThan(0)
    expect(ownerBarrier).toBeLessThan(channelBarrier)
    expect(channelBarrier).toBeLessThan(observedChannel)
    expect(observedChannel).toBeLessThan(authParents)
    expect(authParents).toBeLessThan(lockedChannel)
    expect(lockedChannel).toBeLessThan(roster)
    expect(roster).toBeLessThan(reply)
    expect(reply).toBeLessThan(insert)
    expect(insert).toBeLessThan(readMarker)
    expect(body).toMatch(
      /FROM public\.channel_members AS membership[\s\S]*ORDER BY membership\.user_id[\s\S]*FOR UPDATE/
    )
    expect(body).toContain("'reason', 'MEMBERSHIP_NOT_FOUND'")
    expect(body).toContain("'reason', 'INVALID_REPLY_TARGET'")
    expect(body).toContain("'message', pg_catalog.to_jsonb(v_message)")
    expect(body).toContain("'reply_author_id', v_reply_author_id")
    expect(body).toContain("'read_at', v_read_at")
  })
})
