import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729059000_atomic_referral_attribution.sql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/atomic-referral-attribution.pg17.sh'),
  'utf8'
)
const route = readFileSync(resolve(root, 'app/api/referral/apply/route.ts'), 'utf8')
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  const end = migration.indexOf('ALTER FUNCTION public.', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('atomic referral attribution migration', () => {
  it('is a transactional, replayable expand migration', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain('CREATE OR REPLACE FUNCTION')
    expect(migration).toContain('pg_advisory_xact_lock')
  })

  it('exposes one service-role-only referral authority', () => {
    const body = functionBody('apply_referral_attribution_atomic')

    expect(body).toContain('SECURITY DEFINER')
    expect(body).toContain('SET search_path = pg_catalog, pg_temp')
    expect(body).toContain('SET row_security = off')
    expect(body).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.apply_referral_attribution_atomic\([\s\S]+FROM PUBLIC, anon, authenticated, authenticator, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.apply_referral_attribution_atomic\([\s\S]+TO service_role;/
    )
  })

  it('locks identities before reconciling either half of the immutable edge', () => {
    const body = functionBody('apply_referral_attribution_atomic')
    const identityLock = body.indexOf('ORDER BY profile.id\n  FOR UPDATE')
    const attributionLock = body.indexOf(
      'WHERE attribution.referred_id = p_referred_id\n  FOR UPDATE'
    )
    const attributionInsert = body.indexOf('INSERT INTO public.referral_attributions')
    const profileUpdate = body.lastIndexOf('UPDATE public.user_profiles AS profile')

    expect(identityLock).toBeGreaterThanOrEqual(0)
    expect(attributionLock).toBeGreaterThan(identityLock)
    expect(attributionInsert).toBeGreaterThan(attributionLock)
    expect(profileUpdate).toBeGreaterThan(attributionInsert)
    expect(body).toContain("'status', 'already_applied'")
    expect(body).toContain("'status', 'conflict'")
    expect(body).toContain("'status', 'inconsistent'")
    expect(body).not.toContain('EXCEPTION WHEN')
  })

  it('cuts the route over with strict error, null, status, and identity ACK checks', () => {
    expect(route).toContain("'apply_referral_attribution_atomic'")
    expect(route).toContain('.limit(2)')
    expect(route).toContain('if (!Array.isArray(referrers))')
    expect(route).toContain('referrers.length !== 1')
    expect(route).toContain('if (attributionError || !ack)')
    expect(route).toContain("ack.status === 'conflict'")
    expect(route).toContain("ack.status === 'not_found'")
    expect(route).toContain('ack.referredId !== user.id')
    expect(route).toContain('ack.referrerId !== referrer.id')
    expect(route).not.toContain(".from('referral_attributions')")
    expect(route).not.toContain('.update({ referred_by:')
    expect(route).not.toContain('.insert({ referred_id:')
  })

  it('keeps generated RPC types aligned with the new authority', () => {
    expect(databaseTypes).toContain('apply_referral_attribution_atomic:')
    for (const argument of [
      'p_provider: string | null',
      'p_referred_id: string',
      'p_referrer_id: string',
      'p_signup_ip_hash: string | null',
    ]) {
      expect(databaseTypes).toContain(argument)
    }
  })

  it('proves rollback, retry, half-write repair, concurrency, zero rows, and ACLs on PG17', () => {
    for (const marker of [
      'profile edge failure rolls back the inserted attribution',
      'failed attribution left neither half-write behind',
      'retry atomically creates both referral records',
      'profile-only historical state gains its missing attribution',
      'attribution-only historical state gains its missing profile edge',
      'concurrent referral requests were not serialized',
      'missing referred row is a zero-row not-found result',
      'authenticated RPC execution is closed',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
