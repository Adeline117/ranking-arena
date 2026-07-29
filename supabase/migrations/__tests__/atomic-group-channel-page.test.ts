import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729152500_atomic_group_channel_page.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic group-channel page authority', () => {
  it('is bounded, replayable, and transactional', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.channel_messages:atomic-group-page:migration'")
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_group_channel_page_atomic(')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('depends on every canonical writer sharing the same serializer', () => {
    for (const signature of [
      'public.mutate_channel_member_atomic(uuid,uuid,uuid,text,text)',
      'public.update_group_channel_metadata_atomic(uuid,uuid,text,boolean,text,boolean,text,boolean)',
      'public.send_channel_message_atomic(uuid,uuid,text,text,text,text,uuid)',
      'public.toggle_channel_message_reaction_atomic(uuid,uuid,uuid,text)',
      'public.dissolve_group_channel_atomic(uuid,uuid)',
    ]) {
      expect(migration).toContain(`'${signature}'`)
    }
    expect(migration).toContain("'group-channel-owner-invariant:v1'")
    expect(migration).toContain("'channel-membership:channel:'")
    expect(migration).toContain('canonical channel writer lock contract drifted')
    expect(migration).toContain('channel_message_reads requires UNIQUE (channel_id, user_id)')
  })

  it('publishes one exact service-only RPC and generated type', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_group_channel_page_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_channel_id uuid,[\s\S]*p_before timestamptz,[\s\S]*p_limit integer[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.get_group_channel_page_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.get_group_channel_page_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-group-channel-page:v1:')
    expect(databaseTypes).toContain('get_group_channel_page_atomic: {')
  })

  it('locks current membership before reading private page data', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.get_group_channel_page_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const ownerBarrier = body!.indexOf("'group-channel-owner-invariant:v1'")
    const channelBarrier = body!.indexOf("'channel-membership:channel:'")
    const observedChannel = body!.indexOf('FROM public.chat_channels AS channel_row')
    const authParents = body!.indexOf('FROM auth.users AS auth_user')
    const lockedChannel = body!.lastIndexOf('FROM public.chat_channels AS channel_row')
    const roster = body!.indexOf('FROM public.channel_members AS membership')
    const messages = body!.indexOf('FROM public.channel_messages AS message_row')
    const reactions = body!.indexOf('FROM public.channel_message_reactions AS reaction')
    const readMarker = body!.indexOf('INSERT INTO public.channel_message_reads')

    expect(ownerBarrier).toBeGreaterThan(0)
    expect(ownerBarrier).toBeLessThan(channelBarrier)
    expect(channelBarrier).toBeLessThan(observedChannel)
    expect(observedChannel).toBeLessThan(authParents)
    expect(authParents).toBeLessThan(lockedChannel)
    expect(lockedChannel).toBeLessThan(roster)
    expect(roster).toBeLessThan(messages)
    expect(messages).toBeLessThan(reactions)
    expect(reactions).toBeLessThan(readMarker)
    expect(body).toMatch(
      /FROM public\.channel_members AS membership[\s\S]*ORDER BY membership\.user_id[\s\S]*FOR SHARE/
    )
    expect(body).toContain("'reason', 'MEMBERSHIP_NOT_FOUND'")
  })

  it('returns bounded, stable page evidence and advances reads monotonically', () => {
    expect(migration).toContain('p_limit NOT BETWEEN 1 AND 50')
    expect(migration).toContain('LIMIT p_limit + 1')
    expect(migration).toContain("'reply_preview', reply_preview.value")
    expect(migration).toContain("'reactions', reaction_summary.value")
    expect(migration).toContain("'has_more', v_has_more")
    expect(migration).toContain("'my_role', v_actor_role")
    expect(migration).toContain('ON CONFLICT (channel_id, user_id) DO UPDATE')
    expect(migration).toContain('GET DIAGNOSTICS v_read_count = ROW_COUNT')
    expect(migration).toContain('group-channel read-marker acknowledgement is incomplete')
  })
})
