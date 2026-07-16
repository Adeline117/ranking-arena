import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716114600_group_membership_identity_guard.sql'),
  'utf8'
)

describe('group membership identity guard migration contract', () => {
  it('requires the canonical membership serialization and counter layer', () => {
    expect(migration).toContain('atomic membership migration 20260716113900 must be applied first')
    expect(migration).toContain('trg_group_members_05_serialize_edge')
    expect(migration).toContain('trg_sync_group_member_count')
    expect(migration).toContain('trigger_info.tgtype = 13')
  })

  it('rejects changes to either membership identity column', () => {
    expect(migration).toContain('NEW.group_id IS DISTINCT FROM OLD.group_id')
    expect(migration).toContain('NEW.user_id IS DISTINCT FROM OLD.user_id')
    expect(migration).toContain('group membership identity is immutable; delete and insert instead')
    expect(migration).toContain("USING ERRCODE = '23514'")
  })

  it('uses an all-column AFTER trigger to observe the final row image', () => {
    expect(migration).toContain('CREATE TRIGGER trg_group_members_99_identity_immutable')
    expect(migration).toContain('AFTER UPDATE ON public.group_members')
    expect(migration).not.toContain('AFTER UPDATE OF group_id, user_id')
    expect(migration).toContain('trigger_info.tgtype = 17')
    expect(migration).toContain("trigger_info.tgattr = ''::pg_catalog.int2vector")
  })

  it('recalibrates every count while writes are exclusively locked', () => {
    expect(migration).toContain(
      'LOCK TABLE public.groups, public.group_members IN ACCESS EXCLUSIVE MODE'
    )
    expect(migration).toContain('pg_catalog.count(member.user_id)::integer')
    expect(migration).toContain(
      'target_group.member_count IS DISTINCT FROM exact_count.member_count'
    )
    expect(migration).toContain('member count calibration failed before identity lock')
  })

  it('converges the internal trigger function to an owner-only boundary', () => {
    expect(migration).toContain('DO $converge_function_acl$')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, public')
    expect(migration).toContain('group membership identity guard security drifted')
    expect(migration).toContain('unexpected group membership identity guard overload remains')
  })
})
