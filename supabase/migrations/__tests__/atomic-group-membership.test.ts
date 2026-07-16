import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716113900_atomic_group_membership.sql'),
  'utf8'
)

describe('atomic group membership migration contract', () => {
  it('preflights every join-request column read by its state trigger', () => {
    expect(migration).toContain("('group_join_requests', 'created_at')")
    expect(migration).toContain(
      "('group_join_requests', 'created_at', 'timestamptz'::pg_catalog.regtype)"
    )
    expect(migration).toContain('NEW.created_at')
  })

  it('preflights exact edge and redemption evidence constraints', () => {
    const edgePreflight = migration.indexOf('membership edge primary keys are incompatible')
    const firstTableLock = migration.indexOf('LOCK TABLE')

    expect(edgePreflight).toBeGreaterThan(0)
    expect(firstTableLock).toBeGreaterThan(edgePreflight)
    expect(migration).toContain("'public.group_members'::pg_catalog.regclass")
    expect(migration).toContain("'public.group_bans'::pg_catalog.regclass")
    expect(migration).toContain('AND NOT constraint_info.condeferrable')
    expect(migration).toContain('AND NOT constraint_info.condeferred')

    expect(migration).toContain('AND attribute.attnotnull')
    expect(migration).toContain('JOIN pg_catalog.pg_attrdef AS default_info')
    expect(migration).toContain("= 'clock_timestamp()'")
    expect(migration).toContain("'public.group_invites'::pg_catalog.regclass")
    expect(migration).toContain("'public.groups'::pg_catalog.regclass")
    expect(migration.match(/constraint_info\.confdeltype = 'c'/g)).toHaveLength(2)
    expect(migration).toContain('FROM pg_catalog.pg_constraint AS constraint_info')
    expect(migration).toContain('FROM pg_catalog.pg_index AS index_info')
    expect(migration).toContain('AND index_info.indimmediate')
    expect(migration).toContain('AND NOT trigger_info.tgisinternal')
    expect(migration).toContain('group_invite_redemptions has an incompatible shape')
  })

  it('rejects non-canonical redemption relation authority before side effects', () => {
    const preflight = migration.match(/DO \$preflight\$[\s\S]*?\$preflight\$;/)?.[0]
    const authorityFailure = migration.indexOf(
      'group_invite_redemptions relation authority is incompatible'
    )
    const firstTableLock = migration.indexOf('LOCK TABLE')
    const redemptionCreate = migration.indexOf(
      'CREATE TABLE IF NOT EXISTS public.group_invite_redemptions'
    )

    expect(preflight).toBeDefined()
    expect(preflight).toContain("relation.relkind = 'r'")
    expect(preflight).toContain("relation.relpersistence = 'p'")
    expect(preflight).toContain('AND NOT relation.relispartition')
    expect(preflight).toContain('FROM pg_catalog.pg_rewrite AS rewrite_info')
    expect(preflight).toContain('FROM pg_catalog.pg_inherits AS inheritance_info')
    expect(preflight).toContain('inheritance_info.inhrelid')
    expect(preflight).toContain('inheritance_info.inhparent')
    expect(authorityFailure).toBeGreaterThan(0)
    expect(firstTableLock).toBeGreaterThan(authorityFailure)
    expect(redemptionCreate).toBeGreaterThan(authorityFailure)
  })

  it('fails closed on deploy-time invite and approval ambiguity without deleting evidence', () => {
    expect(migration).toContain('DO $locked_data_preflight$')
    expect(migration).toContain('duplicate group invite token hashes require explicit review')
    expect(migration).toContain('duplicate active group join requests require explicit review')
    expect(migration).not.toMatch(/DELETE FROM public\.group_invites/)
    expect(migration).not.toMatch(/DELETE FROM public\.group_join_requests/)

    const lock = migration.indexOf('LOCK TABLE')
    const dataPreflight = migration.indexOf('DO $locked_data_preflight$')
    const uniqueInvite = migration.indexOf(
      'CREATE UNIQUE INDEX IF NOT EXISTS group_invites_token_hash_unique'
    )
    expect(lock).toBeGreaterThan(0)
    expect(dataPreflight).toBeGreaterThan(lock)
    expect(uniqueInvite).toBeGreaterThan(dataPreflight)
  })

  it('calibrates all counts and converges one COALESCE-safe database trigger', () => {
    expect(migration).toContain('DO $drop_legacy_count_triggers$')
    expect(migration).toContain("'sync_group_member_count'")
    expect(migration).toContain("'update_group_member_count'")
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.update_group_member_count()')
    expect(migration).toContain('CREATE TRIGGER trg_sync_group_member_count')
    expect(migration).toContain('COALESCE(member_count, 0) + 1')
    expect(migration).toContain('GREATEST(COALESCE(member_count, 0) - 1, 0)')
    expect(migration).toContain(
      'target_group.member_count IS DISTINCT FROM exact_count.member_count'
    )
    expect(migration).toContain('ALTER COLUMN member_count SET DEFAULT 0')
    expect(migration).toContain('ALTER COLUMN member_count SET NOT NULL')
    expect(migration).toContain('DO $retire_legacy_member_counters$')
    expect(migration).toContain("'decrement_member_count'")
  })

  it('uses explicit booleans instead of relying on polluted FOUND state', () => {
    expect(migration).toContain('v_profile_found := FOUND')
    expect(migration).toContain('v_group_found := FOUND')
    expect(migration).toContain('v_is_member := FOUND')
    expect(migration).toContain('v_has_approved_request := FOUND')
    expect(migration).toContain('v_invite_found := FOUND')
    expect(migration).not.toMatch(/IF NOT FOUND[\s\S]{0,1000}(?:join|leave)/i)
  })

  it('keeps restricted membership default-deny and consumes both proof types once', () => {
    expect(migration).toContain("IF v_visibility = 'apply' THEN")
    expect(migration).toContain("AND join_request.status = 'approved'")
    expect(migration).toContain("SET status = 'joined'")
    expect(migration).toContain('new group join requests must start pending')
    expect(migration).toContain('CREATE TRIGGER trg_group_join_requests_05_enforce_state')
    expect(migration).toContain("RETURN pg_catalog.jsonb_build_object('status', 'invite_required')")
    expect(migration).toContain("v_visibility NOT IN ('open', 'apply', 'private')")
    expect(migration).toContain('public.group_invite_redemptions')
    expect(migration).toContain(
      "RETURN pg_catalog.jsonb_build_object('status', 'invite_already_used')"
    )
  })

  it('serializes ban and membership edges but leaves moderation for its own rollout', () => {
    expect(migration).toContain(
      "'group-membership:' || p_group_id::text || ':' || p_actor_id::text"
    )
    expect(migration).toContain('CREATE TRIGGER trg_group_members_05_serialize_edge')
    expect(migration).toContain('CREATE TRIGGER trg_group_bans_05_serialize_edge')
    expect(migration).not.toContain('moderate_group_member_atomic')
    expect(migration).not.toContain("p_action IN ('ban'")
  })

  it('exposes only exact service-role atomic entry points', () => {
    expect(migration).toContain('public.mutate_group_membership_atomic(uuid,uuid,text,boolean)')
    expect(migration).toContain('public.redeem_group_invite_atomic(uuid,uuid,text,boolean)')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, public')
    expect(migration).toContain('DO $converge_function_acls$')
    expect(migration).toContain('unexpected atomic membership overload remains')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
