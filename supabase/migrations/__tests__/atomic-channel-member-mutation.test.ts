import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729131858_atomic_channel_member_mutation.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic channel-member mutation authority', () => {
  it('is a bounded, replayable, single-transaction migration', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.channel_members:atomic-member-mutation:migration'")
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.mutate_channel_member_atomic(')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on its exact schema and owner-invariant dependencies', () => {
    expect(migration).toContain("pg_catalog.to_regclass('auth.users')")
    expect(migration).toContain("pg_catalog.to_regclass('public.chat_channels')")
    expect(migration).toContain("pg_catalog.to_regclass('public.channel_members')")
    expect(migration).toContain("ARRAY['channel_id', 'user_id']::name[]")
    expect(migration).toContain("'public.serialize_group_channel_owner_event()'")
    expect(migration).toContain("'public.enforce_group_channel_owner_count()'")
    expect(migration).toContain("'public.add_channel_members_atomic(uuid,uuid,uuid[])'")
    expect(migration).toContain('group-channel owner trigger contract drifted')
    expect(migration).toContain('channel_members service-only write boundary drifted')
    expect(migration).toContain('incompatible mutate_channel_member_atomic overload exists')
  })

  it('publishes one exact service-only security-definer RPC', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.mutate_channel_member_atomic\([\s\S]*p_channel_id uuid,[\s\S]*p_actor_id uuid,[\s\S]*p_target_id uuid,[\s\S]*p_action text,[\s\S]*p_role text DEFAULT NULL[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain(
      'ALTER FUNCTION public.mutate_channel_member_atomic(uuid, uuid, uuid, text, text)'
    )
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.mutate_channel_member_atomic\(uuid, uuid, uuid, text, text\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.mutate_channel_member_atomic\(uuid, uuid, uuid, text, text\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-channel-member-mutation:v1:')
    expect(databaseTypes).toContain('mutate_channel_member_atomic: {')
    expect(databaseTypes).toContain('p_role?: string | null')
  })

  it('serializes owner state, channel state, auth parents, and locked roster in order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.mutate_channel_member_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const ownerBarrier = body!.indexOf("'group-channel-owner-invariant:v1'")
    const channelBarrier = body!.indexOf("'channel-membership:channel:'")
    const observedChannel = body!.indexOf('FROM public.chat_channels AS channel_row')
    const authParents = body!.indexOf('FROM auth.users AS auth_user')
    const lockedChannel = body!.lastIndexOf('FROM public.chat_channels AS channel_row')
    const lockedRoster = body!.indexOf('FROM public.channel_members AS membership')
    const mutation = Math.min(
      body!.indexOf('DELETE FROM public.channel_members'),
      body!.indexOf('UPDATE public.channel_members')
    )

    expect(ownerBarrier).toBeGreaterThan(0)
    expect(ownerBarrier).toBeLessThan(channelBarrier)
    expect(channelBarrier).toBeLessThan(observedChannel)
    expect(observedChannel).toBeLessThan(authParents)
    expect(authParents).toBeLessThan(lockedChannel)
    expect(lockedChannel).toBeLessThan(lockedRoster)
    expect(lockedRoster).toBeLessThan(mutation)
    expect(body).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*ORDER BY auth_user\.id[\s\S]*FOR SHARE/
    )
    expect(body).toMatch(
      /FROM public\.channel_members AS membership[\s\S]*ORDER BY membership\.user_id[\s\S]*FOR UPDATE/
    )
  })

  it('binds authorization and exact write acknowledgements to actor and target roles', () => {
    expect(migration).toContain("p_action NOT IN ('leave', 'remove', 'set_role')")
    expect(migration).toContain("p_role NOT IN ('admin', 'member')")
    expect(migration).toContain("v_actor_role NOT IN ('owner', 'admin')")
    expect(migration).toContain("v_actor_role = 'admin'")
    expect(migration).toContain("v_target_role = 'admin'")
    expect(migration).toContain("v_target_role = 'owner'")
    expect(migration).toMatch(
      /DELETE FROM public\.channel_members AS membership[\s\S]*membership\.channel_id = p_channel_id[\s\S]*membership\.user_id = p_target_id[\s\S]*membership\.role = v_target_role/
    )
    expect(migration).toMatch(
      /UPDATE public\.channel_members AS membership[\s\S]*membership\.channel_id = p_channel_id[\s\S]*membership\.user_id = p_target_id[\s\S]*membership\.role = v_target_role/
    )
    expect(migration).toContain('GET DIAGNOSTICS v_changed_count = ROW_COUNT')
    expect(migration).toContain("'actor_id', p_actor_id")
    expect(migration).toContain("'target_id', p_target_id")
    expect(migration).toContain("'action', p_action")
  })
})
