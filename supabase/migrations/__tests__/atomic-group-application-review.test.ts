import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716111600_atomic_group_application_review.sql'),
  'utf8'
)

describe('atomic group application review migration', () => {
  it('fails closed when the production group schema baseline is incomplete', () => {
    for (const relation of [
      'public.user_profiles',
      'public.subscriptions',
      'public.groups',
      'public.group_members',
      'public.group_applications',
      'public.group_audit_log',
    ]) {
      expect(migration).toContain(`'${relation}'`)
    }
    expect(migration).toContain("pg_catalog.to_regtype('public.member_role')")
    expect(migration).toContain("pg_catalog.to_regclass('public.groups_name_lower_unique')")
    expect(migration).toContain("pg_catalog.to_regclass('public.groups_slug_key')")
  })

  it('carries its premium entitlement predicate without the combined lockdown', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.has_current_global_pro_entitlement'
    )
    expect(migration).toContain('FROM public.subscriptions AS subscription')
    expect(migration).toContain('FROM public.user_profiles AS profile_entitlement')
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.has_current_global_pro_entitlement(uuid)'
    )
  })

  it('serializes submission by actor/name and enforces current premium eligibility', () => {
    expect(migration).toContain("'group-application-actor:' || p_actor_id::text")
    expect(migration).toContain("'group-name:' || pg_catalog.lower(v_name)")
    expect(migration).toMatch(
      /NOT COALESCE\(p_promo_unlocked, false\)[\s\S]*has_current_global_pro_entitlement\(p_actor_id\)[\s\S]*jsonb_build_object\('status', 'pro_required'\)/
    )
    expect(migration).toMatch(
      /pending_application\.applicant_id = p_actor_id[\s\S]*pending_application\.status = 'pending'/
    )
  })

  it('keeps the environment promotion server-controlled on submit and review', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.submit_group_application_atomic\([\s\S]*p_promo_unlocked boolean DEFAULT false/
    )
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.review_group_application_atomic\([\s\S]*p_promo_unlocked boolean DEFAULT false/
    )
    expect(migration).toMatch(
      /COALESCE\(v_application\.is_premium_only, false\)[\s\S]*NOT COALESCE\(p_promo_unlocked, false\)[\s\S]*has_current_global_pro_entitlement\(v_application\.applicant_id\)/
    )
  })

  it('locks one pending review before creating the group, owner edge, link and audit row', () => {
    const reviewStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.review_group_application_atomic'
    )
    const reviewBody = migration.slice(reviewStart)
    const lock = reviewBody.indexOf('FOR UPDATE;')
    const groupInsert = reviewBody.indexOf('INSERT INTO public.groups')
    const ownerInsert = reviewBody.indexOf('INSERT INTO public.group_members')
    const applicationUpdate = reviewBody.indexOf('UPDATE public.group_applications', ownerInsert)
    const auditInsert = reviewBody.indexOf('INSERT INTO public.group_audit_log')

    expect(lock).toBeGreaterThan(0)
    expect(groupInsert).toBeGreaterThan(lock)
    expect(ownerInsert).toBeGreaterThan(groupInsert)
    expect(applicationUpdate).toBeGreaterThan(ownerInsert)
    expect(auditInsert).toBeGreaterThan(applicationUpdate)
    expect(reviewBody).not.toMatch(/EXCEPTION[\s\S]*DELETE FROM public\.groups/)
  })

  it('requires the final database reviewer authority to be an active admin profile', () => {
    const reviewStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.review_group_application_atomic'
    )
    const reviewBody = migration.slice(reviewStart)

    expect(reviewBody).toMatch(
      /FROM public\.user_profiles AS reviewer[\s\S]*reviewer\.id = p_reviewer_id[\s\S]*reviewer\.role = 'admin'[\s\S]*FOR UPDATE;/
    )
    expect(reviewBody).toContain("jsonb_build_object('status', 'reviewer_unauthorized')")
  })

  it('exposes both RPCs only to service_role', () => {
    for (const functionName of [
      'submit_group_application_atomic',
      'review_group_application_atomic',
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated`
        )
      )
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([\\s\\S]*?TO service_role`)
      )
    }
  })
})
