import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716165000_atomic_group_mute.sql'),
  'utf8'
)
const route = readFileSync(
  join(process.cwd(), 'app/api/groups/[id]/members/[userId]/mute/route.ts'),
  'utf8'
)

describe('atomic group mute boundary', () => {
  it('is transactional, replayable, attested and ordered after its dependencies', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("'group-application-authority-migrations'")
    expect(migration).toContain('DO $preflight$')
    expect(migration).toContain('DO $converge_acl_and_attest$')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain("'atomic-group-mute:v2:'")
    expect(migration).toContain('DO $exact_table_authority$')
    expect(migration).toContain('DO $exact_ledger_schema$')
    expect(migration).toContain('DO $converge_identity_sequence_authority$')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON SEQUENCE')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('depends on exact group, Auth, profile, audit and membership authority', () => {
    for (const relation of [
      'auth.users',
      'public.user_profiles',
      'public.groups',
      'public.group_members',
      'public.group_audit_log',
    ]) {
      expect(migration).toContain(relation)
    }
    for (const column of [
      'dissolved_at',
      'muted_until',
      'mute_reason',
      'muted_by',
      'ban_expires_at',
    ]) {
      expect(migration).toContain(`'${column}'`)
    }
    expect(migration).toContain('atomic group-mute key/FK authority is incompatible')
    expect(migration).toContain('public.purge_deleted_account_group_edges(uuid)')
    expect(migration).toContain('trg_group_members_05_serialize_edge')
    expect(migration).toContain('groups/group_members table ACL inventory drifted')
    expect(migration).toContain('pg_catalog.pg_inherits')
    expect(migration).toContain('pg_catalog.pg_rewrite')
  })

  it('attests PostgreSQL 17 automatic role inheritance on every membership edge', () => {
    expect(migration.match(/membership\.inherit_option/g)).toHaveLength(8)
    expect(migration).not.toContain('.rolinherit')
    expect(migration).toContain('service_role has an unsafe effective inheritance edge')
    expect(migration).toContain('service_role effective inheritance boundary drifted')
  })

  it('publishes the exact service-only mute security-definer RPC', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.moderate_group_mute_atomic\([\s\S]*p_operation_id uuid,[\s\S]*p_actor_id uuid,[\s\S]*p_group_id uuid,[\s\S]*p_target_id uuid,[\s\S]*p_action text,[\s\S]*p_muted_until timestamptz,[\s\S]*p_reason text[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain('incompatible moderate_group_mute_atomic overload exists')
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role')
    expect(migration).toContain('TO service_role')
    expect(migration).toContain('atomic group-mute EXECUTE boundary drifted')
    expect(migration).toContain('atomic group-mute function metadata/digest drifted')
    expect(migration).not.toContain('delete_empty_group_atomic')
  })

  it('locks Auth parents, shared membership keys, profiles, group and member rows in order', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.moderate_group_mute_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const deploymentBarrier = body!.indexOf(
      'LOCK TABLE public.group_mute_operations IN ROW EXCLUSIVE MODE'
    )
    const operationLock = body!.indexOf("'group-mute-operation:'")
    const operationLedger = body!.indexOf('FROM public.group_mute_operations AS operation_row')
    const advisory = body!.indexOf("'group-membership:'")
    const auth = body!.indexOf('FROM auth.users AS auth_user')
    const profiles = body!.indexOf('FROM public.user_profiles AS profile')
    const group = body!.indexOf('FROM public.groups AS target_group')
    const members = body!.indexOf('FROM public.group_members AS member')
    const update = body!.indexOf('UPDATE public.group_members AS member')
    const audit = body!.indexOf('INSERT INTO public.group_audit_log')
    const temporalValidation = body!.indexOf('p_muted_until <= v_now')

    expect(deploymentBarrier).toBeGreaterThan(0)
    expect(deploymentBarrier).toBeLessThan(operationLock)
    expect(operationLock).toBeGreaterThan(0)
    expect(operationLock).toBeLessThan(operationLedger)
    expect(operationLedger).toBeLessThan(auth)
    expect(operationLedger).toBeLessThan(temporalValidation)
    expect(advisory).toBeGreaterThan(0)
    expect(auth).toBeLessThan(advisory)
    expect(advisory).toBeLessThan(profiles)
    expect(profiles).toBeLessThan(group)
    expect(group).toBeLessThan(members)
    expect(members).toBeLessThan(update)
    expect(update).toBeLessThan(audit)
    expect(body).toContain('LEAST(p_actor_id::text, p_target_id::text)')
    expect(body).toContain('GREATEST(p_actor_id::text, p_target_id::text)')
    expect(body).toMatch(/ORDER BY auth_user\.id[\s\S]*FOR SHARE/)
    expect(body).toMatch(/ORDER BY profile\.id[\s\S]*FOR UPDATE/)
    expect(body).toMatch(/ORDER BY member\.user_id[\s\S]*FOR UPDATE/)
  })

  it('acquires the complete DDL dependency lock set with bounded all-or-nothing retries', () => {
    const lockBlock = migration.match(
      /DO \$lock_complete_dependency_set\$[\s\S]*?\$lock_complete_dependency_set\$;/
    )?.[0]
    expect(lockBlock).toBeDefined()
    expect(lockBlock).toContain('public.group_mute_operations')
    expect(lockBlock).toContain('auth.users, public.user_profiles')
    expect(lockBlock).toContain('public.groups, public.group_members')
    expect(lockBlock).toContain('public.group_audit_log')
    expect(lockBlock!.match(/NOWAIT/g)).toHaveLength(4)
    expect(lockBlock).toContain('EXCEPTION')
    expect(lockBlock).toContain('WHEN lock_not_available')
    expect(lockBlock).toContain("interval '30 seconds'")
    expect(lockBlock).toContain('pg_catalog.pg_sleep(0.05)')
    expect(lockBlock).toContain("ERRCODE = '55P03'")
    expect(migration).not.toMatch(
      /LOCK TABLE\s+auth\.users,[\s\S]*?IN SHARE MODE;\s*\n\s*LOCK TABLE\s+public\.groups/
    )
  })

  it('fails closed on self, inactive identities, dissolution and hierarchy', () => {
    for (const reason of [
      'SELF_FORBIDDEN',
      'ACTOR_UNAVAILABLE',
      'TARGET_UNAVAILABLE',
      'GROUP_NOT_FOUND',
      'GROUP_DISSOLVED',
      'ACTOR_NOT_MANAGER',
      'TARGET_NOT_MEMBER',
      'OWNER_FORBIDDEN',
      'HIERARCHY_FORBIDDEN',
    ]) {
      expect(migration).toContain(`'${reason}'`)
    }
    expect(migration).toContain("p_muted_until > v_now + INTERVAL '101 years'")
    expect(migration).toContain("p_action = 'unmute' AND (")
    expect(migration).toContain('p_reason IS NOT NULL')
    expect(migration).toContain("pg_catalog.char_length(COALESCE(v_reason, '')) > 500")
    expect(migration).toContain("v_actor_role = 'admin' AND v_target_role <> 'member'")
  })

  it('writes state, canonical audit and durable operation evidence atomically', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.moderate_group_mute_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    expect(migration).toContain('DO $create_group_mute_operations$')
    expect(migration).toContain('CREATE TABLE public.group_mute_operations')
    expect(migration).toContain("'operation_id', p_operation_id")
    expect(migration).toContain('operation id payload collision')
    expect(migration).toContain("'schema', 'group-mute:v2'")
    expect(migration).toContain("'applied', false")
    expect(migration).toContain("'audit_log_id', NULL")
    expect(body!.match(/INSERT INTO public\.group_audit_log/g)).toHaveLength(1)
    expect(body!.match(/INSERT INTO public\.group_mute_operations/g)).toHaveLength(2)
    expect(migration).toContain('GET DIAGNOSTICS v_affected = ROW_COUNT')
    expect(migration).toContain("'audit_log_id', v_audit_id")
    expect(migration).not.toContain('ON CONFLICT')
  })

  it('keeps the ledger owner-only and independent of every deletable parent', () => {
    const muteLedger = migration.match(
      /CREATE TABLE public\.group_mute_operations \([\s\S]*?\n    \);/
    )?.[0]
    expect(muteLedger).toBeDefined()
    expect(muteLedger).not.toContain('REFERENCES')
    expect(muteLedger).not.toContain('ON DELETE CASCADE')
    expect(migration).toContain('ALTER TABLE public.group_mute_operations OWNER TO postgres')
    expect(migration).not.toContain('empty_group_delete_operations')
    expect(migration).toContain('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('CREATE POLICY ledger_owner_all')
    expect(migration).toContain('atomic operation ledger constraint inventory drifted')
    expect(migration).toContain('atomic operation ledger index inventory drifted')
    expect(migration).toContain('group_mute_operations_target_sequence_idx')
    expect(migration).toContain('group_mute_operations_latest_applied_idx')
    expect(migration).toContain("'4 5 2', 3, '0 0 3'")
    expect(migration).toContain("'initial_applied'")
  })

  it('seals genuine legacy evidence once and never downgrades an existing ledger', () => {
    expect(migration).toContain("evidence_kind IN ('legacy_v1', 'operation_v2')")
    expect(migration).toContain('A pre-migration state has no owner-only ledger')
    expect(migration).toContain('legacy mute audit details are not canonical; retry')
    expect(migration).toContain('legacy unmute audit details are not canonical; retry')
    expect(migration).toContain("v_evidence_audit.details ? 'duration'")
    expect(migration).toContain("v_evidence_audit.details IS DISTINCT FROM '{}'::jsonb")
    expect(migration).not.toContain("v_evidence_audit.details ? 'previous_muted_until'")
    expect(migration).toContain('current mute state lacks latest applied operation evidence')
    expect(migration).toContain('current mute state lacks exact audit evidence')
    expect(migration).toContain('ORDER BY operation_row.sequence_id DESC')
    expect(migration).toContain('ORDER BY audit_row.created_at DESC NULLS FIRST')
  })

  it('revokes direct service-role group deletion', () => {
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE public.groups')
    expect(migration).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.groups')
    expect(migration).not.toContain('DELETE FROM public.groups AS target_group')
  })

  it('cuts the route over to one RPC without any direct-message or visible UI mutation', () => {
    expect(route).toContain('await admin.rpc(')
    expect(route).toContain("'moderate_group_mute_atomic' as never")
    expect(route).toContain("req.headers.get('Idempotency-Key')")
    expect(route).toContain('p_operation_id: input.operationId')
    expect(route).toContain('acknowledgement.operationId !== input.operationId')
    expect(route).toContain('operation_id: operationId.data')
    expect(route).toContain('readAtomicMuteAcknowledgement(data)')
    expect(route).toContain('acknowledgement.groupId !== input.groupId')
    expect(route).toContain('acknowledgement.targetId !== input.targetUserId')
    expect(route).toContain('result.applied && result.mutedUntil')
    expect(route).not.toContain('maxMutedUntil')
    expect(route).not.toContain('Invalid mute duration')
    expect(route).toContain('sendNotification(')
    expect(route).not.toContain(".from('conversations')")
    expect(route).not.toContain(".from('direct_messages')")
    expect(route).not.toContain(".from('group_members')")
    expect(route).not.toContain(".from('group_audit_log')")
    expect(route).not.toContain('className=')
    expect(route).toContain('Array.from(value).length <= 500')
  })
})
