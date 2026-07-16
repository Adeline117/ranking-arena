import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationPath = join(
  process.cwd(),
  'supabase/migrations/20260716173000_group_audit_log_read_boundary.sql'
)
const migration = readFileSync(migrationPath, 'utf8')

describe('group audit-log server read boundary migration', () => {
  it('enables zero-policy RLS without forcing owner-side atomic writers through it', () => {
    expect(migration).toContain('ALTER TABLE public.group_audit_log ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('ALTER TABLE public.group_audit_log NO FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('WHERE policy.polrelid = v_relation_oid')
    expect(migration).toContain("'DROP POLICY %I ON public.group_audit_log'")
    expect(migration).toContain('service_role must bypass zero-policy audit-log RLS')
  })

  it('dynamically removes unknown table and column ACLs before granting exact server access', () => {
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('pg_catalog.string_agg')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.group_audit_log FROM %I')
    expect(migration).toContain(
      "'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '"
    )
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE public.group_audit_log TO service_role'
    )
    expect(migration).toContain(
      'FULL JOIN actual\n      USING (grantee, grantor, privilege_type, is_grantable)'
    )
  })

  it('blocks inherited browser authority and bounds deployment locks', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('membership.inherit_option')
    expect(migration).toContain('WHERE inherited.role_oid IN (v_postgres, v_service)')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
