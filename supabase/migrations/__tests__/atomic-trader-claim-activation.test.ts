import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716100000_atomic_trader_claim_activation.sql'),
  'utf8'
)

const activationFunction = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.activate_trader_claim'),
  migration.indexOf('REVOKE ALL ON FUNCTION public.activate_trader_claim')
)

describe('atomic trader claim activation migration', () => {
  it('fails closed unless the linked identity and verified-data foundations exist', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain(
      "to_regprocedure(\n       'public.set_primary_linked_trader(uuid,uuid)'"
    )
    expect(migration).toContain(
      "to_regprocedure(\n       'public.arena_set_trader_claimed(text,text,uuid,boolean)'"
    )
    expect(migration).toContain("column_name = 'scope_permissions'")
    expect(migration).toContain("column_name = 'verified_uid'")
    expect(migration).toContain("column_name = 'read_only_verified_at'")
  })

  it('locks the claim and shared user namespace before changing projections', () => {
    expect(activationFunction).toMatch(
      /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )

    const claimLock = activationFunction.indexOf('FROM public.trader_claims AS claim')
    const userLock = activationFunction.indexOf("'linked-trader:' || v_claim.user_id::text")
    const identityLock = activationFunction.indexOf("'trader-claim:' || v_claim.source")
    const firstProjectionWrite = activationFunction.indexOf(
      'UPDATE public.verified_traders AS verified'
    )

    expect(claimLock).toBeGreaterThan(-1)
    expect(activationFunction.slice(claimLock, userLock)).toContain('FOR UPDATE')
    expect(userLock).toBeGreaterThan(claimLock)
    expect(identityLock).toBeGreaterThan(userLock)
    expect(firstProjectionWrite).toBeGreaterThan(identityLock)
    expect(activationFunction).toContain(
      "v_claim.status NOT IN ('pending', 'reviewing', 'verified')"
    )
    expect(activationFunction).toContain('rejected trader claim cannot be activated')
  })

  it('treats only same-owner identity rows as idempotent', () => {
    expect(activationFunction).toMatch(
      /verified\.trader_id = v_claim\.trader_id[\s\S]*verified\.source = v_claim\.source[\s\S]*FOR UPDATE/
    )
    expect(activationFunction).toMatch(
      /FOUND AND v_verified\.user_id <> v_claim\.user_id[\s\S]*trader identity is already verified by another user/
    )
    expect(activationFunction).toMatch(
      /FOUND AND v_link\.user_id <> v_claim\.user_id[\s\S]*trader identity is already linked to another user/
    )
  })

  it('preserves the primary account and derives the profile from exact database state', () => {
    expect(activationFunction).toMatch(
      /pg_catalog\.max\(linked\.display_order\)[\s\S]*v_linked_count = 0/
    )
    expect(activationFunction).toMatch(
      /linked\.is_primary IS TRUE[\s\S]*ORDER BY linked\.display_order ASC NULLS LAST,[\s\S]*linked\.created_at ASC NULLS LAST,[\s\S]*linked\.id ASC/
    )
    expect(activationFunction).toMatch(
      /SELECT pg_catalog\.count\(\*\)::integer[\s\S]*UPDATE public\.user_profiles AS profile[\s\S]*linked_trader_count = v_linked_count/
    )
    expect(activationFunction).toMatch(/IF NOT FOUND THEN[\s\S]*MESSAGE = 'user profile not found'/)
  })

  it('requires a proven matching read-only connection before authorization upsert', () => {
    expect(activationFunction).toMatch(
      /regexp_replace\([\s\S]*lower\(v_claim\.source\)[\s\S]*'_\(futures\|spot\)\$'/
    )
    expect(activationFunction).toMatch(/connection\.is_active IS TRUE/)
    expect(activationFunction).toMatch(/connection\.verified_uid = v_claim\.trader_id/)
    expect(activationFunction).toMatch(/connection\.last_verified_at IS NOT NULL/)
    expect(activationFunction).toMatch(/btrim\(connection\.api_key_encrypted\) <> ''/)
    expect(activationFunction).toMatch(/btrim\(connection\.api_secret_encrypted\) <> ''/)
    expect(activationFunction).toMatch(/jsonb_typeof\(connection\.scope_permissions\) = 'array'/)
    expect(activationFunction).toMatch(/jsonb_array_length\(connection\.scope_permissions\) > 0/)
    expect(activationFunction).toContain('verified read-only exchange connection not found')
    expect(activationFunction).toMatch(
      /read_only_verified_at,[\s\S]*v_connection\.last_verified_at/
    )
  })

  it('does not erase healthy sync state when an approval is replayed unchanged', () => {
    expect(activationFunction).toMatch(
      /existing_authorization\.encrypted_api_key[\s\S]*IS DISTINCT FROM EXCLUDED\.encrypted_api_key/
    )
    expect(activationFunction).toMatch(/THEN NULL[\s\S]*ELSE existing_authorization\.last_sync_at/)
    expect(activationFunction).toMatch(
      /THEN 'pending'[\s\S]*ELSE existing_authorization\.last_sync_status/
    )
  })

  it('marks Arena and only then exposes the claim as verified', () => {
    const profileWrite = activationFunction.indexOf('UPDATE public.user_profiles AS profile')
    const authorizationWrite = activationFunction.indexOf(
      'INSERT INTO public.trader_authorizations AS existing_authorization'
    )
    const arenaWrite = activationFunction.indexOf(
      'v_arena_trader_id := public.arena_set_trader_claimed'
    )
    const claimWrite = activationFunction.lastIndexOf('UPDATE public.trader_claims AS claim')

    expect(profileWrite).toBeGreaterThan(-1)
    expect(authorizationWrite).toBeGreaterThan(profileWrite)
    expect(arenaWrite).toBeGreaterThan(authorizationWrite)
    expect(claimWrite).toBeGreaterThan(arenaWrite)
    expect(activationFunction.slice(claimWrite)).toContain("status = 'verified'")
  })

  it('exposes activation only to the service role', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.activate_trader_claim\(uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated/
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.activate_trader_claim(uuid, uuid)\n  TO service_role'
    )
  })
})
