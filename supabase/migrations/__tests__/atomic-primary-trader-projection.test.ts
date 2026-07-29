import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729071000_atomic_primary_trader_projection.sql'),
  'utf8'
)

const primaryFunction = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.set_primary_linked_trader'),
  migration.indexOf('ALTER FUNCTION public.set_primary_linked_trader')
)

describe('atomic primary trader projection migration', () => {
  it('locks and repairs all three primary projections in one transaction', () => {
    expect(migration).toMatch(
      /LOCK TABLE[\s\S]*public\.user_linked_traders,[\s\S]*public\.verified_traders,[\s\S]*public\.user_profiles[\s\S]*SHARE ROW EXCLUSIVE/
    )
    expect(migration).toMatch(
      /row_number\(\) OVER[\s\S]*linked\.is_primary DESC NULLS LAST,[\s\S]*linked\.display_order ASC NULLS LAST,[\s\S]*linked\.created_at ASC NULLS LAST/
    )
    expect(migration).toMatch(
      /UPDATE public\.verified_traders AS verified[\s\S]*is_primary = projection\.should_be_primary/
    )
    expect(migration).toMatch(
      /UPDATE public\.user_profiles AS profile[\s\S]*verified_trader_id = projection\.trader_id[\s\S]*linked_trader_count = projection\.linked_count/
    )
  })

  it('proves exact canonical and verified ownership before changing state', () => {
    const linkProof = primaryFunction.indexOf('SELECT linked.*')
    const verifiedProof = primaryFunction.indexOf('SELECT verified.*')
    const firstMutation = primaryFunction.indexOf('UPDATE public.user_linked_traders')

    expect(linkProof).toBeGreaterThan(-1)
    expect(verifiedProof).toBeGreaterThan(linkProof)
    expect(firstMutation).toBeGreaterThan(verifiedProof)
    expect(primaryFunction).toMatch(
      /verified\.user_id = p_user_id[\s\S]*verified\.trader_id = v_target\.trader_id[\s\S]*verified\.source = v_target\.source/
    )
  })

  it('serializes and updates link, verified, and profile rows with one timestamp', () => {
    expect(primaryFunction).toContain("'linked-trader:' || p_user_id::text")
    expect(primaryFunction).toContain('v_now timestamptz := pg_catalog.statement_timestamp()')
    expect(primaryFunction).toMatch(
      /UPDATE public\.user_linked_traders[\s\S]*SET is_primary = false[\s\S]*UPDATE public\.user_linked_traders[\s\S]*SET is_primary = true/
    )
    expect(primaryFunction).toMatch(
      /UPDATE public\.verified_traders[\s\S]*SET is_primary = false[\s\S]*UPDATE public\.verified_traders[\s\S]*SET is_primary = true/
    )
    expect(primaryFunction).toMatch(
      /UPDATE public\.user_profiles[\s\S]*verified_trader_id = v_target\.trader_id[\s\S]*linked_trader_count = v_linked_count/
    )
  })

  it('fails the transaction unless both primary projections are exactly one', () => {
    expect(primaryFunction).toContain('v_linked_primary_count <> 1')
    expect(primaryFunction).toContain('v_linked_target_count <> 1')
    expect(primaryFunction).toContain('v_verified_primary_count <> 1')
    expect(primaryFunction).toContain('v_verified_target_count <> 1')
    expect(primaryFunction).toContain('primary trader projection invariant failed')
    expect(primaryFunction).toContain('user profile not found')
  })

  it('pins function authority and keeps execution service-only', () => {
    expect(migration).toMatch(
      /ALTER FUNCTION public\.set_primary_linked_trader\(uuid, uuid\)[\s\S]*OWNER TO postgres/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.set_primary_linked_trader\(uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.set_primary_linked_trader\(uuid, uuid\)[\s\S]*TO service_role/
    )
    expect(migration).toContain("'search_path=pg_catalog, pg_temp' = ANY(function_row.proconfig)")
  })
})
