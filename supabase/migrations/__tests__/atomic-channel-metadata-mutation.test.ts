import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729133904_atomic_channel_metadata_mutation.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic group-channel metadata mutation authority', () => {
  it('is bounded, replayable, and transactional', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.chat_channels:atomic-metadata-mutation:migration'")
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.update_group_channel_metadata_atomic('
    )
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('depends on the exact prior channel-member lock authority and row shape', () => {
    expect(migration).toContain("'public.mutate_channel_member_atomic(uuid,uuid,uuid,text,text)'")
    expect(migration).toContain("'group-channel-owner-invariant:v1'")
    expect(migration).toContain("'channel-membership:channel:'")
    expect(migration).toContain('atomic channel-member lock contract drifted')
    expect(migration).toContain('chat_channels row shape drifted')
    expect(migration).toContain('channel metadata service-only boundary drifted')
    expect(migration).toContain('incompatible update_group_channel_metadata_atomic overload exists')
  })

  it('publishes one exact service-only security-definer RPC and generated type', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.update_group_channel_metadata_atomic\([\s\S]*p_channel_id uuid,[\s\S]*p_actor_id uuid,[\s\S]*p_name text,[\s\S]*p_name_present boolean,[\s\S]*p_avatar_url text,[\s\S]*p_avatar_url_present boolean,[\s\S]*p_description text,[\s\S]*p_description_present boolean[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.update_group_channel_metadata_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.update_group_channel_metadata_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-channel-metadata-mutation:v1:')
    expect(databaseTypes).toContain('update_group_channel_metadata_atomic: {')
  })

  it('takes canonical owner, channel, Auth, channel-row, and roster locks in order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.update_group_channel_metadata_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const ownerBarrier = body!.indexOf("'group-channel-owner-invariant:v1'")
    const channelBarrier = body!.indexOf("'channel-membership:channel:'")
    const observedChannel = body!.indexOf('FROM public.chat_channels AS channel_row')
    const authParents = body!.indexOf('FROM auth.users AS auth_user')
    const lockedChannel = body!.lastIndexOf('FROM public.chat_channels AS channel_row')
    const lockedRoster = body!.indexOf('FROM public.channel_members AS membership')
    const update = body!.indexOf('UPDATE public.chat_channels AS channel_row')

    expect(ownerBarrier).toBeGreaterThan(0)
    expect(ownerBarrier).toBeLessThan(channelBarrier)
    expect(channelBarrier).toBeLessThan(observedChannel)
    expect(observedChannel).toBeLessThan(authParents)
    expect(authParents).toBeLessThan(lockedChannel)
    expect(lockedChannel).toBeLessThan(lockedRoster)
    expect(lockedRoster).toBeLessThan(update)
    expect(body).toMatch(/FROM auth\.users AS auth_user[\s\S]*FOR SHARE/)
    expect(body).toMatch(
      /FROM public\.channel_members AS membership[\s\S]*ORDER BY membership\.user_id[\s\S]*FOR UPDATE/
    )
  })

  it('validates patch presence, writes only allowed fields, and returns bound evidence', () => {
    expect(migration).toContain(
      'NOT (p_name_present OR p_avatar_url_present OR p_description_present)'
    )
    expect(migration).toContain('p_name_present')
    expect(migration).toContain("v_actor_role NOT IN ('owner', 'admin')")
    expect(migration).toMatch(
      /UPDATE public\.chat_channels AS channel_row[\s\S]*SET name =[\s\S]*avatar_url =[\s\S]*description =[\s\S]*updated_at = pg_catalog\.clock_timestamp\(\)[\s\S]*RETURNING channel_row\.\*/
    )
    expect(migration).toContain("'actor_id', p_actor_id")
    expect(migration).toContain("'channel', pg_catalog.to_jsonb(v_updated_channel)")
    expect(migration).toContain("'changed', v_changed")
    expect(migration).toContain("'applied_fields', pg_catalog.to_jsonb(v_applied_fields)")
  })
})
