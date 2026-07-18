import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationPath = 'supabase/migrations/20260716161000_atomic_group_channel_create.sql'
const migration = readFileSync(join(process.cwd(), migrationPath), 'utf8')
const route = readFileSync(join(process.cwd(), 'app/api/channels/route.ts'), 'utf8')
const channelDetailRoute = readFileSync(
  join(process.cwd(), 'app/api/channels/[channelId]/route.ts'),
  'utf8'
)
const contracts = readFileSync(join(process.cwd(), 'app/api/channels/contracts.ts'), 'utf8')
const modal = readFileSync(
  join(process.cwd(), 'app/components/features/CreateGroupModal.tsx'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic group-channel creation', () => {
  it('is transactional, replayable and ordered after the reserved moderation migration', () => {
    expect(migrationPath).toMatch(/^supabase\/migrations\/20260716161000_/)
    expect(Number(migrationPath.match(/(\d{14})/)?.[1])).toBeGreaterThan(20260716154731)
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'atomic-group-channel-create:migration'")
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.create_group_channel_atomic(')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on exact relation, column, key, FK, constraint, ACL and trigger shapes', () => {
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
      'name',
      'description',
      'dm_permission',
      'deleted_at',
      'banned_at',
      'is_banned',
      'ban_expires_at',
    ]) {
      expect(migration).toContain(`'${column}'`)
    }
    expect(migration).toContain(') <> 11 OR (')
    expect(migration).toContain(') <> 9 OR EXISTS (')
    expect(migration).toContain("relation.relkind = 'r'")
    expect(migration).toContain("relation.relpersistence = 'p'")
    expect(migration).toContain('pg_catalog.pg_inherits')
    expect(migration).toContain('pg_catalog.pg_rewrite')
    expect(migration).toContain("constraint_row.confdeltype = 'c'")
    expect(migration).toContain("constraint_row.confdeltype = 'n'")
    expect(migration).toContain('atomic group-channel constraint inventory is incompatible')
    expect(migration).toContain('group-channel write tables have an unexpected user trigger')
    expect(migration).toContain('group-channel service-only table boundary drifted')
    expect(migration).toContain('REVOKE DELETE ON TABLE public.chat_channels FROM service_role')
    expect(migration).toContain('DO $repair_historical_group_owners$')
    expect(migration).toContain('WHEN membership.user_id = channel_row.created_by THEN 0')
    expect(migration).toContain('ranked_owner.owner_rank > 1')
    expect(migration).toContain('historical group-channel owner repair was incomplete')
    expect(migration).toContain('CREATE TRIGGER trg_serialize_group_channel_owner_event')
    expect(migration).toContain('CREATE TRIGGER trg_serialize_group_channel_owner_event_on_channel')
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER trg_enforce_group_channel_owner_count')
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER trg_enforce_group_channel_owner_count_on_channel'
    )
    expect(migration).toContain('AFTER INSERT OR DELETE OR UPDATE OF role, channel_id, user_id')
    expect(migration).toContain('AFTER INSERT OR UPDATE OF type')
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(migration).toContain('FROM public.channel_members AS remaining_owner')
    expect(migration).toContain('DELETE FROM public.chat_channels AS channel_row')
    expect(migration).toContain("MESSAGE = 'group channel must have exactly one owner'")
    expect(migration).toContain('trigger_row.tgtype = 31')
    expect(migration).toContain('trigger_row.tgtype = 29')
    expect(migration).toContain('trigger_row.tgtype = 21')
  })

  it('depends on the exact existing-channel and block/follow serialization contracts', () => {
    expect(migration).toContain("'public.add_channel_members_atomic(uuid,uuid,uuid[])'")
    expect(migration).toContain('atomic-existing-channel-member-add:v1:')
    expect(migration).toContain('atomic-existing-channel-member-add:v2:')
    expect(migration).toContain('certified existing-channel member-add v2 is required on replay')
    expect(migration).toContain("'public.serialize_direct_message_pair_edge()'")
    expect(migration).toContain("WHEN 'blocked_users' THEN")
    expect(migration).toContain("WHEN 'user_follows' THEN")
    expect(migration).toContain('trg_serialize_dm_block_pair')
    expect(migration).toContain('trg_serialize_dm_follow_pair')
    expect(migration).toContain('trg_serialize_post_audience_block_edge')
    expect(migration).toContain("'public.create_user_follow_notification()'")
    expect(migration).toContain("'public.log_user_follow_activity()'")
    expect(migration).toContain('on_user_follow')
    expect(migration).toContain('trg_log_user_follow_activity')
    expect(migration).toContain('trigger_row.tgtype = 31')
    expect(migration).toContain('trigger_row.tgtype = 5')
    expect(migration).toContain('trigger_row.tgqual IS NULL')
  })

  it('publishes one exact service-only SECURITY DEFINER RPC', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.create_group_channel_atomic\([\s\S]*p_channel_id uuid,[\s\S]*p_actor_id uuid,[\s\S]*p_name text,[\s\S]*p_description text,[\s\S]*p_candidate_ids uuid\[\][\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain(
      'ALTER FUNCTION public.create_group_channel_atomic(uuid, uuid, text, text, uuid[])'
    )
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.create_group_channel_atomic\(uuid, uuid, text, text, uuid\[\]\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.create_group_channel_atomic\(uuid, uuid, text, text, uuid\[\]\)[\s\S]*TO service_role/
    )
    expect(migration).toContain('atomic-group-channel-create:v1:')
    expect(migration).toContain('incompatible create_group_channel_atomic overload exists')
  })

  it('uses the globally compatible owner -> channel -> auth -> pair -> profile -> write order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.create_group_channel_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const ownerKey = body!.indexOf("'group-channel-owner-invariant:v1'")
    const channelKey = body!.indexOf("'channel-membership:channel:'")
    const authRows = body!.indexOf('FROM auth.users AS auth_user')
    const pairKey = body!.indexOf("'direct-message:pair:'")
    const profileRows = body!.indexOf('FROM public.user_profiles AS profile')
    const blockRead = body!.indexOf('FROM public.blocked_users AS block_edge')
    const followRead = body!.indexOf('FROM public.user_follows AS actor_follow')
    const channelInsert = body!.indexOf('INSERT INTO public.chat_channels')
    const memberInsert = body!.indexOf('INSERT INTO public.channel_members')

    expect(ownerKey).toBeGreaterThan(0)
    expect(ownerKey).toBeLessThan(channelKey)
    expect(channelKey).toBeLessThan(authRows)
    expect(authRows).toBeLessThan(pairKey)
    expect(pairKey).toBeLessThan(profileRows)
    expect(profileRows).toBeLessThan(blockRead)
    expect(blockRead).toBeLessThan(followRead)
    expect(followRead).toBeLessThan(channelInsert)
    expect(channelInsert).toBeLessThan(memberInsert)
    expect(body).toMatch(/ORDER BY auth_user\.id[\s\S]*FOR SHARE/)
    expect(body).toMatch(/ORDER BY profile\.id[\s\S]*FOR SHARE/)
    expect(body).toContain('v_observed_created_by')
    expect(body).toContain('v_observed_row_token')
    expect(body).toMatch(
      /FROM auth\.users AS auth_user[\s\S]*FROM public\.chat_channels AS channel_row[\s\S]*FOR UPDATE/
    )
    expect(body).toContain(
      'WHERE left_participant.participant_id <= right_participant.participant_id'
    )
    expect(body).toMatch(
      /ORDER BY[\s\S]*left_participant\.participant_id,[\s\S]*right_participant\.participant_id/
    )
  })

  it('upgrades add-member to shared owner -> observe -> Auth -> channel recheck -> roster -> write', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.add_channel_members_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const ownerLock = body!.indexOf('pg_advisory_xact_lock_shared')
    const ownerKey = body!.indexOf("'group-channel-owner-invariant:v1'")
    const channelKey = body!.indexOf("'channel-membership:channel:'")
    const observation = body!.indexOf('v_observed_channel_exists := FOUND')
    const authRows = body!.indexOf('FROM auth.users AS auth_user')
    const channelRecheck = body!.indexOf('v_rechecked_channel_exists := FOUND')
    const rosterLock = body!.indexOf('v_roster_ids := pg_catalog.array_append')
    const pairKey = body!.indexOf("'direct-message:pair:'")
    const profileRows = body!.indexOf('FROM public.user_profiles AS profile')
    const memberInsert = body!.indexOf('INSERT INTO public.channel_members')

    expect(ownerLock).toBeGreaterThan(0)
    expect(ownerLock).toBeLessThan(ownerKey)
    expect(ownerKey).toBeLessThan(channelKey)
    expect(ownerLock).toBeLessThan(channelKey)
    expect(channelKey).toBeLessThan(observation)
    expect(observation).toBeLessThan(authRows)
    expect(authRows).toBeLessThan(channelRecheck)
    expect(channelRecheck).toBeLessThan(rosterLock)
    expect(rosterLock).toBeLessThan(pairKey)
    expect(pairKey).toBeLessThan(profileRows)
    expect(profileRows).toBeLessThan(memberInsert)
    expect(body).toContain('SELECT v_observed_created_by')
    expect(body).toContain('v_rechecked_row_token IS DISTINCT FROM v_observed_row_token')
    expect(body).toMatch(/ORDER BY auth_user\.id[\s\S]*FOR SHARE/)
    expect(body).toMatch(/ORDER BY membership\.user_id[\s\S]*FOR UPDATE/)
    expect(body).toContain("'channel_id', p_channel_id")
    expect(body).toContain("'added', v_inserted_count")
  })

  it('serializes only owner-affecting events before deferred exact-owner checks', () => {
    const serializer = migration.match(
      /CREATE OR REPLACE FUNCTION public\.serialize_group_channel_owner_event\(\)[\s\S]*?\n\$function\$;/
    )?.[0]
    const checker = migration.match(
      /CREATE OR REPLACE FUNCTION public\.enforce_group_channel_owner_count\(\)[\s\S]*?\n\$function\$;/
    )?.[0]
    expect(serializer).toBeDefined()
    expect(checker).toBeDefined()
    expect(serializer).toContain("TG_TABLE_NAME = 'channel_members'")
    expect(serializer).toContain("TG_TABLE_NAME = 'chat_channels'")
    expect(serializer).toContain("TG_OP NOT IN ('INSERT', 'DELETE', 'UPDATE')")
    expect(serializer).toContain('pg_try_advisory_xact_lock')
    expect(serializer).toContain('FOR SHARE NOWAIT')
    expect(serializer).toContain('OLD.created_by')
    expect(serializer).toContain('WHEN lock_not_available')
    expect(serializer).toContain("MESSAGE = 'group-channel creator deletion is concurrent; retry'")
    expect(serializer).toContain("ERRCODE = '40001'")
    expect(serializer!.indexOf("RETURN CASE WHEN TG_OP = 'DELETE'")).toBeLessThan(
      serializer!.indexOf('pg_try_advisory_xact_lock')
    )
    expect(checker).toContain('pg_advisory_xact_lock')
    expect(checker).not.toContain('pg_try_advisory_xact_lock')
    expect(serializer).toContain("'group-channel-owner-invariant:v1'")
    expect(checker).toContain("'group-channel-owner-invariant:v1'")
    expect(migration).toContain('BEFORE INSERT OR DELETE OR UPDATE OF type')
  })

  it('freezes Auth/privacy parents before channel write tables and removes raw parent delete', () => {
    const authLock = migration.indexOf('LOCK TABLE\n  auth.users,')
    const channelLock = migration.indexOf(
      'LOCK TABLE public.chat_channels, public.channel_members\nIN ACCESS EXCLUSIVE MODE'
    )
    const revokeDelete = migration.indexOf(
      'REVOKE DELETE ON TABLE public.chat_channels FROM service_role'
    )

    expect(authLock).toBeGreaterThan(0)
    expect(authLock).toBeLessThan(channelLock)
    expect(channelLock).toBeLessThan(revokeDelete)
    expect(migration).toContain('ARRAY[3, 4]::integer[]')
    expect(migration).toContain('ARRAY[4]::integer[]')
    expect(migration).toContain("acl_entry.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE')")
  })

  it('dissolves with one owner-first atomic boundary and an exact idempotent acknowledgement', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.dissolve_group_channel_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const ownerKey = body!.indexOf("'group-channel-owner-invariant:v1'")
    const channelKey = body!.indexOf("'channel-membership:channel:'")
    const observation = body!.indexOf('WHERE channel_row.id = p_channel_id;')
    const authLock = body!.indexOf('FROM auth.users AS auth_user')
    const channelRecheck = body!.indexOf('v_rechecked_channel_exists := FOUND')
    const rosterLock = body!.indexOf('v_locked_roster := v_locked_roster')
    const parentDelete = body!.indexOf('DELETE FROM public.chat_channels AS channel_row')

    expect(ownerKey).toBeGreaterThan(0)
    expect(ownerKey).toBeLessThan(channelKey)
    expect(channelKey).toBeLessThan(observation)
    expect(observation).toBeLessThan(authLock)
    expect(authLock).toBeLessThan(channelRecheck)
    expect(channelRecheck).toBeLessThan(rosterLock)
    expect(rosterLock).toBeLessThan(parentDelete)
    expect(body).toContain('v_auth_user_ids IS DISTINCT FROM v_auth_lock_ids')
    expect(body).toContain('v_row_token IS DISTINCT FROM v_observed_row_token')
    expect(body).toContain('v_locked_roster IS DISTINCT FROM v_observed_roster')
    expect(body).toContain("v_actor_role IS DISTINCT FROM 'owner'")
    expect(body).toContain("'applied', false")
    expect(body).toContain("'applied', true")
    expect(body).toContain("'deleted', v_deleted_count")
    expect(migration).toContain('atomic-group-channel-dissolve:v1:')
    expect(migration).toContain('incompatible dissolve_group_channel_atomic overload exists')
    expect(databaseTypes).toContain('dissolve_group_channel_atomic: {')
    expect(databaseTypes).toContain('create_group_channel_atomic: {')
    expect(databaseTypes).toContain('add_channel_members_atomic: {')

    const deleteHandler = channelDetailRoute.match(/export async function DELETE\([\s\S]*$/)?.[0]
    expect(deleteHandler).toBeDefined()
    expect(deleteHandler).toContain(".rpc('dissolve_group_channel_atomic'")
    expect(deleteHandler).toContain('readDissolveChannelAcknowledgement(data)')
    expect(deleteHandler).not.toContain(".from('channel_members')")
    expect(deleteHandler).not.toContain(".from('chat_channels')")
  })

  it('validates the complete prospective roster and privacy graph under locks', () => {
    expect(migration).toContain('pg_catalog.cardinality(p_candidate_ids) NOT BETWEEN 1 AND 49')
    expect(migration).toContain('candidate IDs must be distinct and must not include the actor')
    expect(migration).toContain("'reason', 'ACTOR_UNAVAILABLE'")
    expect(migration).toContain("'reason', 'CANDIDATE_UNAVAILABLE'")
    expect(migration).toContain("'reason', 'PRIVACY_DENIED'")
    expect(migration).toContain("'reason', 'CHANNEL_ID_CONFLICT'")
    expect(migration).toContain("v_profile.dm_permission IN ('all', 'mutual', 'none')")
    expect(migration).toContain("WHEN 'all' THEN")
    expect(migration).toContain("WHEN 'mutual' THEN")
    expect(migration).toContain('block_edge.blocker_id = ANY(v_participant_ids)')
    expect(migration).toContain('block_edge.blocked_id = ANY(v_participant_ids)')
    expect(migration).toContain('actor_follow.follower_id = p_actor_id')
    expect(migration).toContain('candidate_follow.following_id = p_actor_id')
  })

  it('writes the channel and exact owner/member roster with a strict acknowledgement', () => {
    expect(migration).toMatch(
      /INSERT INTO public\.chat_channels \([\s\S]*id,[\s\S]*name,[\s\S]*type,[\s\S]*created_by,[\s\S]*RETURNING \* INTO STRICT v_channel/
    )
    expect(migration).toMatch(
      /INSERT INTO public\.channel_members \([\s\S]*channel_id,[\s\S]*user_id,[\s\S]*role,[\s\S]*CASE WHEN participant_id = p_actor_id THEN 'owner' ELSE 'member' END/
    )
    expect(migration).toContain('v_inserted_candidate_ids IS DISTINCT FROM v_candidate_ids')
    expect(migration).toContain('v_inserted_owner_count <> 1')
    expect(migration).toContain("'member_count', v_inserted_count")
    expect(migration).toContain("'members', v_inserted_roster")
    expect(migration).toContain("'role', role")
    expect(migration).not.toContain('ON CONFLICT')
    expect(migration).toContain('v_existing_roster IS NOT DISTINCT FROM v_expected_roster')
  })

  it('cuts POST /api/channels over to one exact RPC with no filter/write/cleanup fallback', () => {
    const post = route.match(/export async function POST\([\s\S]*$/)?.[0]
    expect(post).toBeDefined()
    expect(post).toContain(".rpc('create_group_channel_atomic'")
    expect(post).toContain('readCreateGroupChannelAcknowledgement(data)')
    expect(post).toContain('acknowledgement.channel.id !== channelId')
    expect(post).toContain('acknowledgement.memberCount !== candidateIds.length + 1')
    expect(post).toContain('acknowledgement.members.some')
    expect(post).toContain("{ error: 'Group creation intent changed' }, { status: 409 }")
    expect(post).not.toContain('filterChannelAddableUsers')
    expect(post).not.toContain(".from('chat_channels')")
    expect(post).not.toContain(".from('channel_members')")
    expect(post).not.toContain('cleanup')
    expect(contracts).toContain('memberIds: z.array(userIdSchema).min(1).max(50)')
    expect(contracts).toContain('channelId: channelIdSchema.optional()')
    expect(post).toContain('if (candidateIds.length > 49)')
    expect(modal).toContain('const creationIntentIdRef = useRef<string | null>(null)')
    expect(modal).toContain('const creationIntentActorIdRef = useRef<string | null>(null)')
    expect(modal).toContain('creationIntentIdRef.current ?? globalThis.crypto.randomUUID()')
    const createHandler = modal.match(
      /const handleCreate = async \(\) => \{[\s\S]*?\n  \}\n\n  return \(/
    )?.[0]
    expect(createHandler).toBeDefined()
    expect(createHandler!.indexOf('try {')).toBeLessThan(
      createHandler!.indexOf('globalThis.crypto.randomUUID()')
    )
    expect(createHandler!.indexOf('globalThis.crypto.randomUUID()')).toBeLessThan(
      createHandler!.indexOf("globalThis.fetch('/api/channels'")
    )
    expect(createHandler!.indexOf('globalThis.crypto.randomUUID()')).toBeLessThan(
      createHandler!.indexOf('finally {')
    )
    expect(modal).toContain('channelId,')
    const closeHandler = modal.match(
      /const handleClose = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[onClose\]\)/
    )?.[0]
    expect(closeHandler).toBeDefined()
    expect(closeHandler).not.toContain('creationIntentIdRef.current = null')
    expect(createHandler).toMatch(
      /if \(creationIntentActorIdRef\.current !== actorScope\)[\s\S]*creationIntentIdRef\.current = null[\s\S]*creationIntentActorIdRef\.current = actorScope/
    )
    expect(createHandler).toContain('if (!accessToken || !userId)')
    expect(createHandler).toContain('const actorScope = userId.toLowerCase()')
    expect(createHandler).not.toContain("?? 'anonymous'")
    expect(createHandler).toMatch(
      /if \([\s\S]*res\.ok[\s\S]*data\.channel\?\.id === channelId[\s\S]*data\.channel\?\.type === 'group'[\s\S]*\) \{\s*creationIntentIdRef\.current = null[\s\S]*handleClose\(\)/
    )
    expect(modal).toMatch(
      /const toggleMember[\s\S]*creationIntentIdRef\.current = null[\s\S]*setGroupName/
    )
    expect(modal).toMatch(
      /onChange=\{\(e\) => \{[\s\S]*creationIntentIdRef\.current = null[\s\S]*setGroupName\(e\.target\.value\)/
    )
    expect(modal).toMatch(
      /onChange=\{\(e\) => \{[\s\S]*creationIntentIdRef\.current = null[\s\S]*setDescription\(e\.target\.value\)/
    )
  })
})
