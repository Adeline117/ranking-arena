import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729162500_primary_trader_account_lifecycle.sql'),
  'utf8'
)

const wrapperStart = migration.indexOf('CREATE FUNCTION public.set_primary_linked_trader(')
const wrapper = migration.slice(
  wrapperStart,
  migration.indexOf('ALTER FUNCTION public.set_primary_linked_trader(uuid, uuid)', wrapperStart)
)

describe('primary trader account lifecycle authority', () => {
  it('enters through active account lifecycle authority before linked projection logic', () => {
    expect(wrapper).toContain("COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(wrapper.indexOf('lock_trader_claim_principals_internal')).toBeLessThan(
      wrapper.indexOf('set_primary_linked_trader_without_account_lifecycle_internal')
    )
    expect(wrapper).toContain('ARRAY[p_user_id]::uuid[]')
    expect(wrapper).toMatch(/ARRAY\[p_user_id\]::uuid\[\],[\s\S]*true/)
  })

  it('keeps the canonical projection implementation private', () => {
    expect(migration).toContain(
      'RENAME TO set_primary_linked_trader_without_account_lifecycle_internal'
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*set_primary_linked_trader_without_account_lifecycle_internal\(uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role, authenticator/
    )
    expect(migration).toContain(
      "'public.set_primary_linked_trader_without_account_lifecycle_internal(uuid,uuid)'"
    )
  })

  it('pins a service-only runtime, ACL, RLS, and timeout boundary', () => {
    expect(migration).toContain('SET row_security = off')
    expect(migration).toContain("SET lock_timeout = '5s'")
    expect(migration).toContain("SET statement_timeout = '20s'")
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role, authenticator')
    expect(migration).toContain('TO service_role')
    expect(migration).toContain("'row_security=off'")
    expect(migration).toContain("'statement_timeout=20s'")
  })

  it('fails closed unless the old linked-to-profile implementation is present', () => {
    expect(migration).toContain("pg_catalog.strpos(v_function_definition, 'linked-trader:')")
    expect(migration).toContain("pg_catalog.strpos(v_function_definition, 'FOR UPDATE')")
    expect(migration).toContain(
      "pg_catalog.strpos(v_function_definition, 'UPDATE public.user_profiles')"
    )
    expect(migration).toContain('primary trader linked/profile lock foundation drifted')
  })
})
