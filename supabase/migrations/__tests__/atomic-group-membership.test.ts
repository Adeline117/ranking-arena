import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716113900_atomic_group_membership.sql'),
  'utf8'
)

describe('atomic group membership migration contract', () => {
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
