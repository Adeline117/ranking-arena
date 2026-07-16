import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716112000_exchange_connections_server_only.sql'),
  'utf8'
)

describe('exchange connections server-only migration', () => {
  it('is transactional, bounded, and documents the application-first cutover', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('deploy 61b2a00b3')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on an incompatible credential schema or missing owner key', () => {
    for (const securityColumn of [
      'api_key_encrypted',
      'api_secret_encrypted',
      'passphrase_encrypted',
      'verified_uid',
      'last_verified_at',
      'scope_permissions',
    ]) {
      expect(migration).toContain(`'${securityColumn}'`)
    }

    expect(migration).toContain('index_metadata.indisunique')
    expect(migration).toContain('index_metadata.indisvalid')
    expect(migration).toContain('index_metadata.indisready')
    expect(migration).toContain("ARRAY['user_id', 'exchange']::name[]")
    expect(migration.indexOf('DO $preflight$')).toBeLessThan(
      migration.indexOf('REVOKE ALL PRIVILEGES ON TABLE public.user_exchange_connections')
    )
  })

  it('removes every table and column privilege from browser roles', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.user_exchange_connections\s+FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain('DO $revoke_column_privileges$')
    expect(migration).toContain(
      "'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '"
    )
    expect(migration).toContain("|| 'FROM PUBLIC, anon, authenticated, service_role'")
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*?TO\s+(?:PUBLIC|anon|authenticated)\s*;/
    )
  })

  it('dynamically replaces policy drift with one service-role policy', () => {
    expect(migration).toContain('DO $drop_exchange_connection_policies$')
    expect(migration).toContain(
      "WHERE policy.polrelid = 'public.user_exchange_connections'::regclass"
    )
    expect(migration).toContain("'DROP POLICY %I ON public.user_exchange_connections'")
    expect(migration.match(/CREATE POLICY /g)).toHaveLength(1)
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages exchange connections"[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\)/
    )
  })

  it('grants only service CRUD and performs strict ACL and policy postflight', () => {
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.user_exchange_connections\s+TO service_role/
    )
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('has_table_privilege')
    expect(migration).toContain('has_column_privilege')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('acl_entry.grantee = 0::oid')
    expect(migration).toContain('policy.polroles = ARRAY[v_service_role_oid]::oid[]')
    expect(migration).toContain(') <> 1 OR NOT EXISTS (')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('does not force RLS and break owner-executed security-definer claim code', () => {
    expect(migration).toContain(
      'ALTER TABLE public.user_exchange_connections ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).not.toContain(
      'ALTER TABLE public.user_exchange_connections FORCE ROW LEVEL SECURITY'
    )
  })
})
