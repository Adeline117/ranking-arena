import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729060000_retryable_referral_qualification.sql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/retryable-referral-qualification.pg17.sh'),
  'utf8'
)
const route = readFileSync(resolve(root, 'app/api/cron/qualify-referrals/route.ts'), 'utf8')
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  const next = migration.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1)
  const alter = migration.indexOf('ALTER FUNCTION public.', start)
  const end = next >= 0 && next < alter ? next : alter
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('retryable referral qualification migration', () => {
  it('adds explicit unfinished friend, advocate, and candidate state', () => {
    expect(migration).toContain('friend_grant_status text NOT NULL DEFAULT')
    expect(migration).toContain('advocate_evaluated_at timestamptz')
    expect(migration).toContain('qualification_checked_at timestamptz')
    expect(migration).toContain('entitlement_granted_at timestamptz')
    expect(migration).toContain('idx_referral_attributions_qualification_pending')
    expect(migration).toContain("friend_grant_status = 'pending'")
  })

  it('exposes service-role-only claim and settlement authorities', () => {
    const body = functionBody('qualify_referral_attribution_atomic')
    const claimBody = functionBody('claim_referral_qualification_candidates_atomic')

    for (const authorityBody of [claimBody, body]) {
      expect(authorityBody).toContain('SECURITY DEFINER')
      expect(authorityBody).toContain('SET search_path = pg_catalog, pg_temp')
      expect(authorityBody).toContain('SET row_security = off')
      expect(authorityBody).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    }
    expect(body).toContain("'referral-qualification-authority'")
    expect(claimBody).toContain("'referral-qualification-authority'")
    expect(claimBody).toContain('FOR UPDATE SKIP LOCKED')
    expect(claimBody).toContain('SET qualification_checked_at = p_now')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.claim_referral_qualification_candidates_atomic\([\s\S]+FROM PUBLIC, anon, authenticated, authenticator, service_role;/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.qualify_referral_attribution_atomic\([\s\S]+FROM PUBLIC, anon, authenticated, authenticator, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.qualify_referral_attribution_atomic\([\s\S]+TO service_role;/
    )
  })

  it('keeps qualification, friend grant, device cap, marker, and advocate grant atomic', () => {
    const body = functionBody('qualify_referral_attribution_atomic')
    const qualify = body.indexOf('SET qualified_at = p_now')
    const friendGrant = body.indexOf('public.grant_pro_entitlement_days_atomic(')
    const friendState = body.indexOf("friend_grant_status = 'granted'", friendGrant)
    const rewardMarker = body.indexOf('INSERT INTO public.referral_rewards')
    const advocateGrant = body.lastIndexOf('public.grant_pro_entitlement_days_atomic(')
    const advocateState = body.indexOf('SET entitlement_granted_at = p_now')
    const evaluated = body.indexOf('SET advocate_evaluated_at = p_now')

    expect(qualify).toBeGreaterThanOrEqual(0)
    expect(friendGrant).toBeGreaterThan(qualify)
    expect(friendState).toBeGreaterThan(friendGrant)
    expect(rewardMarker).toBeGreaterThan(friendState)
    expect(advocateGrant).toBeGreaterThan(rewardMarker)
    expect(advocateState).toBeGreaterThan(advocateGrant)
    expect(evaluated).toBeGreaterThan(advocateState)
    expect(body).not.toContain('EXCEPTION WHEN')
  })

  it('repairs old flags and markers through stable entitlement identities', () => {
    const body = functionBody('qualify_referral_attribution_atomic')

    expect(body).toContain("'friend:' || v_attribution.id::text")
    expect(body).toContain("'advocate:' || v_reward.id::text")
    expect(body).toContain('v_attribution.created_at')
    expect(body).toContain('v_reward.created_at')
    expect(body).toContain("NOT IN ('granted', 'already_granted')")
  })

  it('cuts the cron over to pending candidates and strict atomic ACK handling', () => {
    expect(route).toContain("'claim_referral_qualification_candidates_atomic'")
    expect(route).toContain("'qualify_referral_attribution_atomic'")
    expect(route).toContain('if (!Array.isArray(rawCandidates))')
    expect(route).toContain('qualificationError ||')
    expect(route).toContain('ack.attributionId !== candidate.id')
    expect(route).toContain('if (failedCount > 0)')
    expect(route).not.toContain('.update(')
    expect(route).not.toContain('.insert(')
    expect(route).not.toContain('.delete(')
  })

  it('keeps generated table and RPC types aligned', () => {
    for (const marker of [
      'advocate_evaluated_at: string | null',
      'friend_grant_status: string',
      'qualification_checked_at: string | null',
      'entitlement_granted_at: string | null',
      'claim_referral_qualification_candidates_atomic:',
      'qualify_referral_attribution_atomic:',
      'p_advocate_days: number',
      'p_attribution_id: string',
      'p_now: string',
    ]) {
      expect(databaseTypes).toContain(marker)
    }
  })

  it('proves rollback, retry, concurrency, repair, caps, zero rows, and ACLs on PG17', () => {
    for (const marker of [
      'injected advocate grant failure rolls back qualification and friend grant',
      'retry settles qualification and both entitlements',
      'concurrent qualification did not serialize',
      'flag-first historical state repairs its missing friend grant',
      'marker-first historical state repairs its missing advocate grant',
      'device cap records a terminal capped outcome',
      'next claim rotates past the already-checked pending row',
      'missing attribution is a zero-row not-found result',
      'authenticated qualification execution is closed',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
