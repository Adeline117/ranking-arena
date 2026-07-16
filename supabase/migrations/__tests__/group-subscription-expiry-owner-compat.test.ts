import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationPath = join(
  process.cwd(),
  'supabase/migrations/20260716174000_group_subscription_expiry_owner_compat.sql'
)
const migration = readFileSync(migrationPath, 'utf8')

describe('group subscription expiry owner compatibility migration', () => {
  it('keeps browser RLS enabled without forcing the postgres-owned expiry writer through it', () => {
    expect(migration).toContain('ALTER TABLE public.group_subscriptions ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain(
      'ALTER TABLE public.group_subscriptions NO FORCE ROW LEVEL SECURITY'
    )
    expect(migration).not.toContain(
      'ALTER TABLE public.group_subscriptions FORCE ROW LEVEL SECURITY'
    )
    expect(migration).toContain('procedure_row.proowner <> v_postgres')
    expect(migration).toContain('OR NOT procedure_row.prosecdef')
  })

  it('replays unknown table, column, policy, and function ACL drift to exact server authority', () => {
    expect(migration).toContain('DO $converge_table_authority$')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public.group_subscriptions FROM %s CASCADE'
    )
    expect(migration).toContain(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
    )
    expect(migration).toContain("'DROP POLICY %I ON public.group_subscriptions'")
    expect(migration).toContain('DO $converge_expiry_function$')
    expect(migration).toContain("'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE'")
    expect(migration).toContain(
      "'GRANT EXECUTE ON FUNCTION public.expire_group_subscriptions() TO service_role'"
    )
  })

  it('asserts exact service CRUD, service-only policy, expiry execution, and parent cascade', () => {
    expect(migration).toContain(
      'FULL JOIN actual\n      USING (grantee, grantor, privilege_type, is_grantable)'
    )
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.group_subscriptions\s+TO service_role/
    )
    expect(migration).toMatch(
      /CREATE POLICY service_role_manages_group_subscriptions[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\)/
    )
    expect(migration).toContain("VALUES (v_service, v_postgres, 'EXECUTE'::text, false)")
    expect(migration).toContain("constraint_row.confdeltype = 'c'")
    expect(migration).toContain('group subscription parent cascade drifted')
  })

  it('fails closed on active browser, service, or unprivileged owner inheritance paths', () => {
    expect(migration).toContain('WITH RECURSIVE owner_authority(member_oid)')
    expect(migration).toContain('WITH RECURSIVE browser_authority(root_oid, role_oid)')
    expect(migration).toContain('membership.inherit_option OR membership.set_option')
    expect(migration).toContain('NOT role_row.rolsuper')
    expect(migration).toContain('AND NOT role_row.rolbypassrls')
    expect(migration).toContain('inherited.role_oid IN (v_service, v_postgres)')
  })

  it('uses bounded locking and contains no application or presentation change', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('LOCK TABLE public.group_subscriptions IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).not.toMatch(/(?:jsx|tsx|className|grid-template|tailwind)/i)
  })
})
