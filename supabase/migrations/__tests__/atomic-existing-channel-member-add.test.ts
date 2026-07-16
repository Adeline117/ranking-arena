import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716152647_atomic_existing_channel_member_add.sql'),
  'utf8'
)
const memberRoute = readFileSync(
  join(process.cwd(), 'app/api/channels/[channelId]/members/route.ts'),
  'utf8'
)
const createRoute = readFileSync(join(process.cwd(), 'app/api/channels/route.ts'), 'utf8')

describe('atomic existing-channel member addition', () => {
  it('is transactional, bounded, replayable and ordered after its dependencies', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'atomic-existing-channel-member-add:migration'")
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.add_channel_members_atomic(')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toMatch(
      /LOCK TABLE[\s\S]*public\.chat_channels,[\s\S]*auth\.users,[\s\S]*public\.channel_members[\s\S]*IN SHARE MODE/
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on exact relation, column, key, rewrite and trigger dependencies', () => {
    for (const relation of [
      'chat_channels',
      'channel_members',
      'user_profiles',
      'blocked_users',
      'user_follows',
      'auth.users',
    ]) {
      expect(migration).toContain(relation)
    }
    for (const column of [
      'dm_permission',
      'deleted_at',
      'banned_at',
      'is_banned',
      'ban_expires_at',
    ]) {
      expect(migration).toContain(`'${column}'`)
    }
    expect(migration).toContain("relation.relkind = 'r'")
    expect(migration).toContain("relation.relpersistence = 'p'")
    expect(migration).toContain('pg_catalog.pg_inherits')
    expect(migration).toContain('pg_catalog.pg_rewrite')
    expect(migration).toContain("ARRAY['channel_id', 'user_id']::name[]")
    expect(migration).toContain("ARRAY['blocker_id', 'blocked_id']::name[]")
    expect(migration).toContain("ARRAY['follower_id', 'following_id']::name[]")
    expect(migration).toContain("constraint_row.confdeltype = 'c'")
    expect(migration).toContain('channel_members constraint inventory is incompatible')
    expect(migration).toContain('channel_members has an unexpected user trigger')
    expect(migration).toContain('channel_members service-only table boundary drifted')
  })

  it('depends on the exact block/follow pair serializer instead of a private lock namespace', () => {
    expect(migration).toContain("'public.serialize_direct_message_pair_edge()'")
    expect(migration).toContain("WHEN 'blocked_users' THEN")
    expect(migration).toContain("WHEN 'user_follows' THEN")
    expect(migration).toContain('trg_serialize_dm_block_pair')
    expect(migration).toContain('trg_serialize_dm_follow_pair')
    expect(migration).toContain('trg_serialize_post_audience_block_edge')
    expect(migration).toContain('block/follow trigger inventory is incompatible')
    expect(migration).toContain("'direct-message:pair:'")
    expect(migration).toContain('trigger_row.tgtype = 31')
    expect(migration).toContain('trigger_row.tgqual IS NULL')
  })

  it('publishes one exact service-only SECURITY DEFINER RPC', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.add_channel_members_atomic\([\s\S]*p_channel_id uuid,[\s\S]*p_actor_id uuid,[\s\S]*p_candidate_ids uuid\[\][\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain(
      'ALTER FUNCTION public.add_channel_members_atomic(uuid, uuid, uuid[])'
    )
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.add_channel_members_atomic\(uuid, uuid, uuid\[\]\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.add_channel_members_atomic\(uuid, uuid, uuid\[\]\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-existing-channel-member-add:v1:')
    expect(migration).toContain('incompatible add_channel_members_atomic overload exists')
  })

  it('locks channel, auth parents, reconciled roster children, participant pairs and profiles in that order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.add_channel_members_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const channelKey = body!.indexOf("'channel-membership:channel:'")
    const channelRow = body!.indexOf('FROM public.chat_channels AS channel_row')
    const observedRosterRows = body!.indexOf('FROM public.channel_members AS membership')
    const pairKey = body!.indexOf("'direct-message:pair:'")
    const authRows = body!.indexOf('FROM auth.users AS auth_user')
    const lockedRosterRows = body!.lastIndexOf('FROM public.channel_members AS membership')
    const profileRows = body!.indexOf('FROM public.user_profiles AS profile')
    const blockRead = body!.indexOf('FROM public.blocked_users AS block_edge')
    const insert = body!.indexOf('INSERT INTO public.channel_members')

    expect(channelKey).toBeGreaterThan(0)
    expect(channelKey).toBeLessThan(channelRow)
    expect(channelRow).toBeLessThan(observedRosterRows)
    expect(observedRosterRows).toBeLessThan(authRows)
    expect(authRows).toBeLessThan(lockedRosterRows)
    expect(lockedRosterRows).toBeLessThan(pairKey)
    expect(authRows).toBeLessThan(profileRows)
    expect(pairKey).toBeLessThan(profileRows)
    expect(profileRows).toBeLessThan(blockRead)
    expect(blockRead).toBeLessThan(insert)
    expect(body).toContain('v_observed_roster_ids')
    expect(body).toContain('WHERE NOT roster_id = ANY(v_observed_roster_ids)')
    expect(body).toContain("ERRCODE = '40001'")
    expect(body).toMatch(
      /FROM public\.channel_members AS membership[\s\S]*FROM public\.channel_members AS membership[\s\S]*ORDER BY membership\.user_id[\s\S]*FOR UPDATE/
    )
    expect(body).toMatch(/ORDER BY auth_user\.id[\s\S]*FOR SHARE/)
    expect(body).toMatch(/ORDER BY profile\.id[\s\S]*FOR SHARE/)
  })

  it('rechecks active profiles, bidirectional blocks and exact DM preferences before insert', () => {
    expect(migration).toContain("WHEN 'all' THEN")
    expect(migration).toContain("WHEN 'mutual' THEN")
    expect(migration).toContain('NULL, none and any future/legacy unknown preference fail closed')
    expect(migration).toContain('block_edge.blocker_id = ANY(v_participant_ids)')
    expect(migration).toContain('block_edge.blocked_id = ANY(v_participant_ids)')
    expect(migration).toContain('actor_follow.follower_id = p_actor_id')
    expect(migration).toContain('candidate_follow.following_id = p_actor_id')
    expect(migration).toContain('v_profile.deleted_at IS NULL')
    expect(migration).toContain('v_profile.banned_at IS NULL')
    expect(migration).toContain('v_profile.is_banned IS TRUE')
    expect(migration).toContain("'reason', 'PRIVACY_DENIED'")
    expect(migration).toContain("'reason', 'CANDIDATE_UNAVAILABLE'")
  })

  it('inserts only new regular members and verifies the complete RETURNING acknowledgement', () => {
    expect(migration).toMatch(
      /INSERT INTO public\.channel_members \([\s\S]*id,[\s\S]*channel_id,[\s\S]*user_id,[\s\S]*role[\s\S]*'member'[\s\S]*RETURNING channel_id, user_id, role/
    )
    expect(migration).toContain('v_inserted_ids IS DISTINCT FROM v_new_candidate_ids')
    expect(migration).toContain(
      "MESSAGE = 'channel membership insert acknowledgement is incomplete'"
    )
    expect(migration).toContain("'channel_id', p_channel_id")
    expect(migration).toContain("'added', v_inserted_count")
    expect(migration).not.toContain('ON CONFLICT')
  })

  it('cuts only the existing-channel POST route over to the exact RPC acknowledgement', () => {
    const post = memberRoute.match(
      /export async function POST\([\s\S]*?\nexport async function DELETE/
    )?.[0]
    expect(post).toBeDefined()
    expect(post).toContain("'add_channel_members_atomic' as never")
    expect(post).toContain('readAddMembersAcknowledgement(data)')
    expect(post).toContain('acknowledgement.channelId !== channelId')
    expect(post).not.toContain(".from('channel_members')")
    expect(post).not.toContain('filterChannelAddableUsers')

    // Channel creation is deliberately a separate follow-up boundary.
    expect(createRoute).toContain('filterChannelAddableUsers')
    expect(createRoute).toContain("supabase.from('channel_members').insert(members)")
    expect(createRoute).not.toContain('create_group_channel_atomic')
  })
})
