import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729156000_atomic_group_notification_broadcast.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')
const postprocessor = readFileSync(
  join(process.cwd(), 'scripts/postprocess-database-types.mjs'),
  'utf8'
)

describe('atomic group notification broadcast authority', () => {
  it('is replayable, bounded and transactional', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'public.group_notification_broadcast:atomic:migration'")
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

  it('publishes one service-only idempotent RPC and private durable ledger', () => {
    expect(migration).toContain('CREATE TABLE public.group_notification_broadcast_operations (')
    expect(migration).toContain('PRIMARY KEY (operation_id)')
    expect(migration).toContain("'group-notification-operation:' || p_operation_id::text")
    expect(migration).toContain("'group-notification-broadcast:v1'")
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.broadcast_group_notification_atomic\([\s\S]*p_operation_id uuid,[\s\S]*p_actor_id uuid,[\s\S]*p_group_id uuid,[\s\S]*p_title text,[\s\S]*p_message text,[\s\S]*p_target_user_ids uuid\[\] DEFAULT NULL[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.broadcast_group_notification_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.broadcast_group_notification_atomic\([\s\S]*TO service_role/
    )
    expect(databaseTypes).toContain('group_notification_broadcast_operations: {')
    expect(databaseTypes).toContain('broadcast_group_notification_atomic: {')
    expect(postprocessor).toContain('broadcast_group_notification_atomic: {')
  })

  it('locks identities, membership edges, DM pairs and current rows in safe order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.broadcast_group_notification_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const authParent = body!.indexOf('FROM auth.users AS auth_user')
    const memberEdge = body!.indexOf("'group-membership:' || p_group_id::text")
    const dmPair = body!.indexOf("'direct-message:pair:' || v_pair")
    const profile = body!.indexOf('FROM public.user_profiles AS profile')
    const group = body!.indexOf('FROM public.groups AS target_group')
    const membership = body!.indexOf('FROM public.group_members AS member', group)
    const canonicalSend = body!.indexOf('public.send_direct_message_atomic(')
    const notificationInsert = body!.indexOf('INSERT INTO public.notifications')
    const ledgerInsert = body!.indexOf('INSERT INTO public.group_notification_broadcast_operations')

    expect(authParent).toBeGreaterThan(0)
    expect(authParent).toBeLessThan(memberEdge)
    expect(memberEdge).toBeLessThan(dmPair)
    expect(dmPair).toBeLessThan(profile)
    expect(profile).toBeLessThan(group)
    expect(group).toBeLessThan(membership)
    expect(membership).toBeLessThan(canonicalSend)
    expect(canonicalSend).toBeLessThan(notificationInsert)
    expect(notificationInsert).toBeLessThan(ledgerInsert)
    expect(body).toMatch(/FROM auth\.users AS auth_user[\s\S]*FOR KEY SHARE/)
    expect(body).toMatch(/FROM public\.user_profiles AS profile[\s\S]*FOR SHARE/)
    expect(body).toMatch(/FROM public\.groups AS target_group[\s\S]*FOR SHARE/)
    expect(body).toMatch(/FROM public\.group_members AS member[\s\S]*FOR SHARE/)
  })

  it('revalidates managers and recipients and preserves canonical DM denials', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.broadcast_group_notification_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()
    expect(migration).toContain("v_actor_role NOT IN ('owner', 'admin')")
    expect(migration).toContain('member.self_notify_muted IS NOT TRUE')
    expect(migration).toContain('v_member.user_id = ANY(v_active_profile_ids)')
    expect(migration).toContain("'TOO_MANY_RECIPIENTS'")
    expect(migration).toContain('LIMIT 501')
    expect(migration).toContain('public.send_direct_message_atomic(')
    expect(migration).toContain("'dm_delivered', v_dm_delivered")
    expect(migration).toContain("'dm_skipped', v_dm_skipped")
    expect(body).not.toContain('INSERT INTO public.direct_messages')
    expect(body).not.toContain('INSERT INTO public.conversations')
  })
})
