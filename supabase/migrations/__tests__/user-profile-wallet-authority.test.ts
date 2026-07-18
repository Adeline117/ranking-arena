import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

const migration = read('supabase/migrations/20260716179200_user_profile_wallet_authority.sql')
const linkRoute = read('app/api/auth/siwe/link/route.ts')
const verifyRoute = read('app/api/auth/siwe/verify/route.ts')

describe('user profile wallet authority migration', () => {
  it('installs atomically under the shared identity-authority lock', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("'user-profile-authority-migrations'")
    expect(migration).toContain('LOCK TABLE public.user_profiles IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('fails closed on role, owner, column, and index drift', () => {
    for (const role of ['postgres', 'anon', 'authenticated', 'service_role']) {
      expect(migration).toContain(`'${role}'`)
    }
    expect(migration).toContain('public.user_profiles must be an ordinary postgres-owned table')
    expect(migration).toContain('public.user_profiles wallet columns are incompatible')
    expect(migration).toContain('wallet index name belongs to another relation')
    expect(migration).toContain('wallet index definition is incompatible and was preserved')
    expect(migration).toContain('wallet shape constraint is incompatible and was preserved')
    expect(migration).toContain('pg_catalog.pg_get_indexdef(\n          index_row.indexrelid')
    expect(migration).toContain('pg_catalog.pg_get_expr(\n          index_row.indpred')
  })

  it('clears every ambiguous or invalid historical owner before canonicalizing singletons', () => {
    expect(migration).toContain('CREATE TEMPORARY TABLE pg_temp.user_profile_wallet_conflicts')
    expect(migration).toMatch(
      /GROUP BY pg_catalog\.lower\(profile\.wallet_address\)[\s\S]*?HAVING pg_catalog\.count\(\*\) > 1/
    )
    expect(migration).toMatch(
      /SET wallet_address = NULL[\s\S]*?wallet_address !~ '\^0x\[0-9A-Fa-f\]\{40\}\$'[\s\S]*?user_profile_wallet_conflicts/
    )
    expect(migration).toMatch(/SET wallet_address = pg_catalog\.lower\(profile\.wallet_address\)/)
  })

  it('enforces lowercase shape and case-insensitive uniqueness in the database', () => {
    expect(migration).toMatch(
      /ADD CONSTRAINT user_profiles_wallet_address_shape_check[\s\S]*?wallet_address = pg_catalog\.lower\(wallet_address\)[\s\S]*?'\^0x\[0-9a-f\]\{40\}\$'/
    )
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX user_profiles_wallet_address_lower_unique[\s\S]*?pg_catalog\.lower\(wallet_address\)[\s\S]*?WHERE wallet_address IS NOT NULL/
    )
    expect(migration).toContain('persisted wallet identities violate the canonical contract')
  })

  it('removes browser wallet writes while preserving service binding authority', () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE ON TABLE public\.user_profiles[\s\S]*?FROM PUBLIC, anon, authenticated/
    )
    expect(migration).toMatch(
      /REVOKE INSERT \(wallet_address\), UPDATE \(wallet_address\)[\s\S]*?FROM PUBLIC, anon, authenticated/
    )
    expect(migration).toMatch(
      /GRANT SELECT \(wallet_address\), UPDATE \(wallet_address\)[\s\S]*?TO service_role/
    )
    expect(migration).toContain('browser role retains wallet mutation authority')
    expect(migration).toContain('service wallet authority is unavailable')
    expect(migration).toMatch(
      /GRANT UPDATE \([\s\S]*?handle,[\s\S]*?search_history[\s\S]*?TO authenticated/
    )
    expect(migration).toContain('safe profile update column was not preserved')
  })

  it('matches SIWE lowercase and unique-conflict handling', () => {
    expect(linkRoute).toContain('const walletAddress = fields.address.toLowerCase()')
    expect(linkRoute).toContain("updateError?.code === '23505'")
    expect(linkRoute).toContain('This wallet is already linked to another account')
    expect(verifyRoute).toContain('const walletAddress = fields.address.toLowerCase()')
    expect(verifyRoute).toContain("error.code === '23505'")
    expect(verifyRoute).toContain('This wallet is already linked to another account')
  })
})
