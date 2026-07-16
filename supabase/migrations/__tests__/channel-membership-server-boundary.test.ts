import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const migrationPath = join(
  process.cwd(),
  'supabase/migrations/20260716112100_channel_membership_server_boundary.sql'
)
const migration = readFileSync(migrationPath, 'utf8')

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sourceFilesBelow(path)
    return /\.(?:ts|tsx)$/.test(path) ? [path] : []
  })
}

describe('channel membership server boundary migration', () => {
  it('is a bounded transaction with an application-first rollout dependency', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('Rollout dependency: deploy the current server-admin')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on missing route/RPC columns, roles, signatures, and indexes', () => {
    for (const relation of [
      'chat_channels',
      'channel_members',
      'channel_messages',
      'channel_message_reactions',
      'user_profiles',
      'blocked_users',
      'user_follows',
      'direct_messages',
    ]) {
      expect(migration).toContain(`'${relation}'`)
    }

    for (const securityColumn of [
      'dm_permission',
      'deleted_at',
      'banned_at',
      'blocker_id',
      'blocked_id',
      'follower_id',
      'following_id',
      'sender_id',
      'receiver_id',
    ]) {
      expect(migration).toContain(`'${securityColumn}'`)
    }

    expect(migration).toContain("pg_catalog.to_regprocedure('auth.role()')")
    expect(migration).toContain("pg_catalog.to_regprocedure('auth.uid()')")
    expect(migration).toContain("'public.check_dm_permission(uuid,uuid)'")
    expect(migration).toContain("'public.is_current_user_channel_member(uuid)'")
    expect(migration).toContain("ARRAY['p_sender_id', 'p_receiver_id']::text[]")
    expect(migration).toContain('index_metadata.indisvalid')
    expect(migration).toContain('index_metadata.indisready')
    expect(migration).toContain("ARRAY['channel_id', 'user_id']::name[]")
    expect(migration).toContain("ARRAY['blocker_id', 'blocked_id']::name[]")
    expect(migration).toContain("ARRAY['follower_id', 'following_id']::name[]")
    expect(migration).toContain("ARRAY['sender_id', 'receiver_id']::name[]")
    expect(migration.indexOf('DO $preflight$')).toBeLessThan(
      migration.indexOf('REVOKE ALL PRIVILEGES ON TABLE public.chat_channels')
    )
  })

  it('makes channel metadata/membership service-only and converges unknown policies', () => {
    for (const relation of ['chat_channels', 'channel_members']) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL PRIVILEGES ON TABLE public\\.${relation}\\s+FROM PUBLIC, anon, authenticated, service_role`
        )
      )
      expect(migration).toMatch(
        new RegExp(
          `GRANT SELECT, INSERT, UPDATE, DELETE\\s+ON TABLE public\\.${relation}\\s+TO service_role`
        )
      )
    }

    expect(migration).toContain('DO $revoke_channel_column_privileges$')
    expect(migration).toContain(
      "'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '"
    )
    expect(migration).toContain('DO $drop_channel_policies$')
    expect(migration).toContain("'DROP POLICY %I ON public.%I'")
    expect(migration.match(/CREATE POLICY /g)).toHaveLength(6)
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages chat channels"[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\)/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages channel members"[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\)/
    )
  })

  it('preserves member-only Realtime reads while cutting all browser message writes', () => {
    for (const relation of ['channel_messages', 'channel_message_reactions']) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL PRIVILEGES ON TABLE public\\.${relation}\\s+FROM PUBLIC, anon, authenticated, service_role`
        )
      )
      expect(migration).toMatch(
        new RegExp(
          `GRANT SELECT, INSERT, UPDATE, DELETE\\s+ON TABLE public\\.${relation}\\s+TO service_role`
        )
      )
      expect(migration).toMatch(
        new RegExp(`GRANT SELECT ON TABLE public\\.${relation} TO authenticated`)
      )
    }

    expect(migration).toMatch(
      /CREATE POLICY "Authenticated members read channel messages"[\s\S]*FOR SELECT[\s\S]*TO authenticated[\s\S]*is_current_user_channel_member\(channel_id\)/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Authenticated members read channel message reactions"[\s\S]*FOR SELECT[\s\S]*TO authenticated[\s\S]*parent_message\.id = channel_message_reactions\.message_id[\s\S]*is_current_user_channel_member\(parent_message\.channel_id\)/
    )
    expect(migration).not.toContain('CREATE POLICY "Members can send messages"')
    expect(migration).not.toContain('CREATE POLICY "Channel members can add their own reaction"')
    expect(migration).not.toContain('CREATE POLICY "Users can remove their own channel reaction"')
  })

  it('uses only auth.uid identity in the fixed-search-path membership predicate', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.is_current_user_channel_member\(\s*p_channel_id uuid\s*\)\s*RETURNS boolean[\s\S]*STABLE[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain('v_actor_id := auth.uid()')
    expect(migration).toContain("v_actor_role IS DISTINCT FROM 'authenticated'")
    expect(migration).toContain("v_actor_role IS DISTINCT FROM 'service_role'")
    expect(migration).not.toMatch(
      /is_current_user_channel_member\([\s\S]{0,100}p_(?:user|actor)_id/
    )
    expect(migration).toContain('JOIN public.user_profiles AS actor_profile')
    expect(migration).toContain('actor_profile.id = membership.user_id')
    expect(migration).toContain('actor_profile.deleted_at IS NULL')
    expect(migration).toContain('actor_profile.banned_at IS NULL')
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES\s+ON FUNCTION public\.is_current_user_channel_member\(uuid\)\s+FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.is_current_user_channel_member\(uuid\)\s+TO authenticated, service_role/
    )
  })

  it('makes the explicit-sender DM RPC service-only with a defense-in-depth role gate', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.check_dm_permission\([\s\S]*p_sender_id uuid,[\s\S]*p_receiver_id uuid[\s\S]*\)\s*RETURNS jsonb/
    )
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).not.toContain('SET search_path = pg_catalog, public')
    expect(migration).toContain("auth.role() IS DISTINCT FROM 'service_role'")
    expect(migration).toContain("USING ERRCODE = '42501'")
    expect(migration).toContain("USING ERRCODE = '22023'")
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES\s+ON FUNCTION public\.check_dm_permission\(uuid, uuid\)\s+FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.check_dm_permission\(uuid, uuid\)\s+TO service_role/
    )
  })

  it('implements the active receiver, block, privacy, and exact three-message contract', () => {
    expect(migration).toContain('FROM public.user_profiles AS sender_profile')
    expect(migration).toContain('sender_profile.id = p_sender_id')
    expect(migration).toContain('sender_profile.deleted_at IS NULL')
    expect(migration).toContain('sender_profile.banned_at IS NULL')
    expect(migration).toContain("'reason', 'SENDER_UNAVAILABLE'")
    expect(migration).toContain('profile.deleted_at IS NULL')
    expect(migration).toContain('profile.banned_at IS NULL')
    expect(migration).toContain("'reason', 'USER_NOT_FOUND'")
    expect(migration).toContain('block_edge.blocker_id = p_sender_id')
    expect(migration).toContain('block_edge.blocker_id = p_receiver_id')
    expect(migration).toContain("'reason', 'BLOCKED'")
    expect(migration).toContain("v_dm_permission = 'none'")
    expect(migration).toContain("'reason', 'DM_DISABLED'")
    expect(migration).toContain("v_dm_permission = 'all'")
    expect(migration).not.toContain("v_dm_permission = 'everyone'")
    expect(migration).toContain("v_dm_permission <> 'mutual'")
    expect(migration).toContain("'is_mutual', true")
    expect(migration).toContain("'receiver_replied', true")
    expect(migration).toContain("'allowed', v_sent_count < 3")
    expect(migration).toContain("'sent_count', v_sent_count")
    expect(migration).toContain("WHEN v_sent_count >= 3 THEN 'LIMIT_REACHED'")

    expect(migration.indexOf("'reason', 'BLOCKED'")).toBeLessThan(
      migration.indexOf("v_dm_permission = 'all'")
    )
    expect(migration.indexOf("'reason', 'SENDER_UNAVAILABLE'")).toBeLessThan(
      migration.indexOf('SELECT profile.dm_permission')
    )
  })

  it('strictly postflights RLS, ACLs, policies, owner, signature, and function grants', () => {
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('has_table_privilege')
    expect(migration).toContain('has_column_privilege')
    expect(migration).toContain('has_function_privilege')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('policy.polroles = ARRAY[v_service_role_oid]::oid[]')
    expect(migration).toContain('procedure.prosecdef')
    expect(migration).toContain("procedure.prorettype <> 'jsonb'::regtype")
    expect(migration).toContain("ARRAY['search_path=pg_catalog, pg_temp']::text[]")
    expect(migration).toContain('v_expected_read_expression := CASE v_relation_name')
    expect(migration).toContain('pg_catalog.regexp_replace(')
    expect(migration).toContain("'public.is_current_user_channel_member(channel_id)'")
    expect(migration).not.toContain('AND policy.polqual IS NOT NULL')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('proves every current channel storage query/write is already on the admin client', () => {
    const appDirectory = join(process.cwd(), 'app')
    const baseTableSources = sourceFilesBelow(appDirectory)
      .filter((path) => {
        const source = readFileSync(path, 'utf8')
        return /\.from\(\s*['"](?:chat_channels|channel_members|channel_messages|channel_message_reactions)['"]\s*\)/.test(
          source
        )
      })
      .map((path) => relative(process.cwd(), path))
      .sort()

    expect(baseTableSources).toEqual(
      [
        'app/api/channels/[channelId]/members/route.ts',
        'app/api/channels/[channelId]/messages/[messageId]/react/route.ts',
        'app/api/channels/[channelId]/messages/route.ts',
        'app/api/channels/[channelId]/read/route.ts',
        'app/api/channels/[channelId]/route.ts',
        'app/api/channels/route.ts',
      ].sort()
    )

    for (const path of baseTableSources) {
      expect(path).toMatch(/^app\/api\//)
      expect(readFileSync(join(process.cwd(), path), 'utf8')).toMatch(/getSupabaseAdmin\(\)/)
    }
  })

  it('keeps the only browser channel-message reads on Realtime subscriptions', () => {
    const appDirectory = join(process.cwd(), 'app')
    const realtimeSources = sourceFilesBelow(appDirectory)
      .filter((path) => {
        const source = readFileSync(path, 'utf8')
        return /table:\s*['"](?:channel_messages|channel_message_reactions)['"]/.test(source)
      })
      .map((path) => relative(process.cwd(), path))
      .sort()

    expect(realtimeSources).toEqual(
      [
        'app/(app)/channels/[channelId]/page.tsx',
        'app/components/inbox/ConversationsList.tsx',
      ].sort()
    )

    for (const path of realtimeSources) {
      const source = readFileSync(join(process.cwd(), path), 'utf8')
      expect(source).toMatch(/(?:useRealtime|postgres_changes)/)
    }
  })

  it('proves both current DM callers receive the admin client from withAuth', () => {
    const middleware = readFileSync(join(process.cwd(), 'lib/api/middleware.ts'), 'utf8')
    expect(middleware).toMatch(
      /const supabase = getSupabaseAdmin\(\)[\s\S]*handler\(\{ user, supabase, request, version: versionContext \}\)/
    )

    for (const route of ['app/api/messages/route.ts', 'app/api/messages/start/route.ts']) {
      const source = readFileSync(join(process.cwd(), route), 'utf8')
      expect(source).toContain('withAuth(')
      expect(source).toContain("'check_dm_permission'")
      expect(source).toContain('p_sender_id: senderId')
      expect(source).toContain('p_receiver_id: receiverId')
    }
  })
})
