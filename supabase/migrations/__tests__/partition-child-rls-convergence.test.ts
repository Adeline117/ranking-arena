import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260718135000_partition_child_rls_convergence.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(
  join(process.cwd(), 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)

describe('partition child RLS and ACL convergence', () => {
  it('is append-only, transactional, and registered as predeploy', () => {
    expect(migration).toMatch(/^BEGIN;$/m)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toMatch(
      /LOCK TABLE ONLY arena\.copier_records IN SHARE UPDATE EXCLUSIVE MODE;/
    )
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(runner).toContain(migrationName)
  })

  it('hardens existing and future children and removes direct child policies', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION arena.ensure_month_partitions')
    expect(migration).not.toMatch(/v_partition_oid IS NOT NULL[^{]*CONTINUE/s)
    expect(migration.match(/WITH RECURSIVE roots/g)?.length).toBeGreaterThanOrEqual(4)
    expect(migration).toContain('ALTER TABLE arena.%I ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('REVOKE ALL ON TABLE arena.%I FROM PUBLIC')
    expect(migration).toContain('REVOKE ALL ON TABLE arena.%I FROM %I')
    expect(migration).toContain('DROP POLICY %I ON arena.%I')
  })

  it('fails closed if any descendant retains disabled RLS, unsafe ownership, ACL, or policy', () => {
    expect(migration).toContain('AND NOT child.relrowsecurity')
    expect(migration).toContain("child.relowner <> 'postgres'::pg_catalog.regrole::oid")
    expect(migration).toContain('AND privilege.grantee <> child.relowner')
    expect(migration).toContain('partition children retained RLS-disabled relations')
    expect(migration).toContain('partition children retained non-postgres owners')
    expect(migration).toContain('partition children retained non-owner ACLs')
    expect(migration).toContain('partition children retained direct policies')
    expect(migration).toContain('arena partition parents retained cross-schema children')
  })
})
