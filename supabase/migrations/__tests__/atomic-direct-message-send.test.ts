import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationPath = join(
  process.cwd(),
  'supabase/migrations/20260716114000_atomic_direct_message_send.sql'
)
const migration = readFileSync(migrationPath, 'utf8')

describe('atomic direct-message send migration', () => {
  it('is bounded, transactional, replay-safe, and explicitly database-first', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('pg_try_advisory_xact_lock')
    expect(migration).toContain('20260716112100 must deploy first')
    expect(migration).toContain('only then switch the API route')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on exact schema, key, trigger, owner, and dependency drift', () => {
    for (const relation of [
      'blocked_users',
      'conversations',
      'direct_messages',
      'notifications',
      'user_follows',
      'user_profiles',
    ]) {
      expect(migration).toContain(`'${relation}'`)
    }

    expect(migration).toContain('canonical 20260716112100 check_dm_permission contract is required')
    expect(migration).toContain("'search_path=pg_catalog, pg_temp'")
    expect(migration).toContain("ARRAY['user1_id', 'user2_id']::name[]")
    expect(migration).toContain("= 'user1_id<user2_id'")
    expect(migration).toContain("ARRAY['sender_id', 'receiver_id']::name[]")
    expect(migration).toContain('on_dm_sent')
    expect(migration).toContain('on_dm_received')
    expect(migration).toContain('trigger_row.tgtype = 5')
    expect(migration).toContain('rows outside their canonical participant pair')
    expect(migration).toContain('rows with invalid content/media shape')
    expect(migration).toContain('cross-thread reply edges')
    expect(migration.indexOf('DO $preflight$')).toBeLessThan(
      migration.indexOf('LOCK TABLE public.blocked_users')
    )
  })

  it('removes browser write paths while retaining participant-only Realtime reads', () => {
    expect(migration).toContain('DO $revoke_nonowner_table_access$')
    expect(migration).toContain('DO $revoke_nonowner_column_access$')
    expect(migration).toContain('DO $drop_message_policies$')
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.conversations, public\.direct_messages\s+TO service_role/
    )
    expect(migration).toMatch(
      /GRANT SELECT\s+ON TABLE public\.conversations, public\.direct_messages\s+TO authenticated/
    )
    expect(migration).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)[^;]*\b(?:anon|authenticated)\b/)
    expect(migration).toMatch(
      /CREATE POLICY "Authenticated participants read conversations"[\s\S]*FOR SELECT[\s\S]*TO authenticated[\s\S]*auth\.uid\(\)/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Authenticated participants read direct messages"[\s\S]*FOR SELECT[\s\S]*TO authenticated[\s\S]*conversation\.user1_id = LEAST\(sender_id, receiver_id\)/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Authenticated participants read direct messages"[\s\S]*direct_messages\.deleted_at IS NULL/
    )
    expect(
      migration.match(/is_current_user_active_for_direct_messages\(\)/g)?.length
    ).toBeGreaterThan(2)
    expect(migration.match(/CREATE POLICY /g)).toHaveLength(4)
  })

  it('requires an active JWT actor for every authenticated DM read', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.is_current_user_active_for_direct_messages\(\)[\s\S]*STABLE[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain("v_actor_role IS DISTINCT FROM 'authenticated'")
    expect(migration).toContain('actor_profile.deleted_at IS NULL')
    expect(migration).toContain('actor_profile.banned_at IS NULL')
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.is_current_user_active_for_direct_messages\(\)[\s\S]*TO authenticated, service_role/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Authenticated participants read conversations"[\s\S]*public\.is_current_user_active_for_direct_messages\(\)/
    )
  })

  it('hardens existing side-effect triggers without duplicating their work in the RPC', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.update_conversation_on_message\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*UPDATE public\.conversations/
    )
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.create_message_notification\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*INSERT INTO public\.notifications/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.update_conversation_on_message\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.create_message_notification\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )

    const rpcBody = migration.match(
      /CREATE FUNCTION public\.send_direct_message_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(rpcBody).toBeDefined()
    expect(rpcBody).toContain('INSERT INTO public.direct_messages')
    expect(rpcBody).not.toContain('INSERT INTO public.notifications')
    expect(rpcBody).not.toContain('UPDATE public.conversations')
    expect(migration).toContain(
      'exactly one canonical direct-message summary/notification trigger is required'
    )
    expect(migration).toContain('direct-message side-effect triggers are not exactly once')
    expect(migration).toMatch(/trigger_row\.tgfoid = v_notification_function[\s\S]*\) <> 1/)
  })

  it('serializes sends, block edges, follow edges, and legacy message rows on one pair key', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.serialize_direct_message_pair_edge\(\)[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain("'direct-message:pair:' || v_pair")
    expect(migration).toContain("WHEN 'blocked_users' THEN")
    expect(migration).toContain("WHEN 'user_follows' THEN")
    expect(migration).toContain("WHEN 'direct_messages' THEN")
    expect(migration).toMatch(
      /CREATE TRIGGER trg_serialize_dm_block_pair[\s\S]*ON public\.blocked_users/
    )
    expect(migration).toMatch(
      /CREATE TRIGGER trg_serialize_dm_follow_pair[\s\S]*ON public\.user_follows/
    )
    expect(migration).toMatch(
      /CREATE TRIGGER trg_serialize_dm_message_pair[\s\S]*ON public\.direct_messages/
    )

    const rpcPairLock = /pg_advisory_xact_lock\([\s\S]*?'direct-message:pair:' \|\| v_pair/
    expect(migration).toMatch(rpcPairLock)
    expect(migration).toMatch(
      /FROM public\.user_profiles AS profile[\s\S]*ORDER BY profile\.id[\s\S]*FOR SHARE/
    )
  })

  it('enforces structural message and reply integrity for staged legacy service writers', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.validate_direct_message_integrity\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain('direct message must use its participants canonical conversation')
    expect(migration).toContain('reply target is not visible in this direct-message thread')
    expect(migration).toMatch(
      /CREATE TRIGGER trg_validate_direct_message_integrity[\s\S]*BEFORE INSERT OR UPDATE OF[\s\S]*ON public\.direct_messages/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.validate_direct_message_integrity\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
  })

  it('publishes exactly one fixed-path service-only route-compatible RPC', () => {
    expect(migration).toMatch(
      /CREATE FUNCTION public\.send_direct_message_atomic\([\s\S]*p_sender_id uuid,[\s\S]*p_receiver_id uuid,[\s\S]*p_content text,[\s\S]*p_media_url text DEFAULT NULL,[\s\S]*p_media_type text DEFAULT NULL,[\s\S]*p_media_name text DEFAULT NULL,[\s\S]*p_reply_to_id uuid DEFAULT NULL[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /ALTER FUNCTION public\.send_direct_message_atomic\([\s\S]*\) OWNER TO postgres/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.send_direct_message_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.send_direct_message_atomic\([\s\S]*TO service_role/
    )
    expect(migration).toContain("'message', pg_catalog.to_jsonb(v_message)")
    expect(migration).toContain("'conversation_id', v_conversation_id")
  })

  it('validates content/media and preserves canonical permission denial fields', () => {
    expect(migration).toContain('pg_catalog.char_length(v_content) NOT BETWEEN 1 AND 2000')
    expect(migration).toContain("v_media_url !~ '^https://[^[:space:]]+$'")
    expect(migration).toContain("v_media_type NOT IN ('image', 'video', 'file')")
    expect(migration).toContain('pg_catalog.char_length(v_media_name) > 255')
    expect(migration).toMatch(
      /v_permission := public\.check_dm_permission\([\s\S]*p_sender_id,[\s\S]*p_receiver_id/
    )
    expect(migration).toContain(
      "RETURN v_permission || pg_catalog.jsonb_build_object('success', false)"
    )
  })

  it('validates reply visibility before conversation creation and inserts atomically', () => {
    expect(migration).toContain('parent_message.deleted_at IS NULL')
    expect(migration).toContain('parent_message.sender_id = p_sender_id')
    expect(migration).toContain('parent_message.receiver_id = p_sender_id')
    expect(migration).toContain("'reason', 'INVALID_REPLY_TARGET'")
    expect(migration.indexOf('IF p_reply_to_id IS NOT NULL')).toBeLessThan(
      migration.indexOf('INSERT INTO public.conversations')
    )
    expect(migration).toMatch(
      /INSERT INTO public\.conversations \(user1_id, user2_id\)[\s\S]*ON CONFLICT \(user1_id, user2_id\) DO NOTHING/
    )
    expect(migration).toMatch(
      /INSERT INTO public\.direct_messages[\s\S]*RETURNING \* INTO v_message/
    )
  })

  it('postflights exact ACLs, policies, functions, triggers, and overload cleanup', () => {
    expect(migration).toContain('DO $drop_legacy_atomic_dm_functions$')
    expect(migration).toContain('DO $revoke_unknown_function_access$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('pg_catalog.has_table_privilege')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('policy.polroles = ARRAY[v_authenticated_oid]::oid[]')
    expect(migration).toContain('function_row.pronargdefaults = 4')
    expect(migration).toContain('trigger_row.tgtype = 31')
    expect(migration).toContain('trigger_row.tgtype = 23')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('does not switch the application route in the SQL-first batch', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/messages/route.ts'), 'utf8')
    expect(route).not.toContain('send_direct_message_atomic')
    expect(route).toContain("'check_dm_permission'")
  })
})
