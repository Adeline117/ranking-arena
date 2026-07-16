import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716103000_trader_identity_server_write_only.sql'),
  'utf8'
)

describe('trader identity server-write-only migration', () => {
  it('is bounded and refuses to run before atomic activation exists', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain(
      "to_regprocedure(\n       'public.activate_trader_claim(uuid,uuid)'"
    )

    expect(migration.indexOf('to_regprocedure(')).toBeLessThan(
      migration.indexOf('REVOKE ALL PRIVILEGES ON TABLE public.trader_claims')
    )
  })

  it('keeps only authenticated own-claim reads for browser roles', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.trader_claims[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain('GRANT SELECT ON TABLE public.trader_claims TO authenticated')
    expect(migration).toMatch(
      /CREATE POLICY "Authenticated users can view own trader claims"[\s\S]*FOR SELECT[\s\S]*TO authenticated[\s\S]*auth\.uid\(\)[\s\S]*user_id/
    )
    expect(migration).not.toMatch(
      /GRANT (?:INSERT|UPDATE|DELETE)[\s\S]*ON TABLE public\.trader_claims[\s\S]*TO (?:anon|authenticated)/
    )
  })

  it('preserves public verified-identity reads without browser writes', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.verified_traders[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain(
      'GRANT SELECT ON TABLE public.verified_traders TO anon, authenticated'
    )
    expect(migration).toMatch(
      /CREATE POLICY "Public can view verified traders"[\s\S]*FOR SELECT[\s\S]*TO anon, authenticated[\s\S]*USING \(true\)/
    )
    expect(migration).not.toMatch(
      /GRANT (?:INSERT|UPDATE|DELETE)[\s\S]*ON TABLE public\.verified_traders[\s\S]*TO (?:anon|authenticated)/
    )
  })

  it('keeps identity table mutations and atomic activation service-only', () => {
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE[\s\S]*ON TABLE public\.trader_claims, public\.verified_traders[\s\S]*TO service_role/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages trader claims"[\s\S]*FOR ALL[\s\S]*TO service_role/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages verified traders"[\s\S]*FOR ALL[\s\S]*TO service_role/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.activate_trader_claim\(uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.activate_trader_claim\(uuid, uuid\)[\s\S]*TO service_role/
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('removes every historical browser-write policy', () => {
    for (const policyName of [
      'Users can insert their own claims',
      'Users can delete their own pending claims',
      'Users can update their own verified profile',
      'Service role can manage all claims',
      'Service role can manage verified traders',
    ]) {
      expect(migration).toContain(`DROP POLICY IF EXISTS "${policyName}"`)
    }
  })
})
