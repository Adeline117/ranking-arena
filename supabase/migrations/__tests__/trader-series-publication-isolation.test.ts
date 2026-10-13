import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

const migrationName = '20260817060000_trader_series_publication_isolation.sql'
const migration = read(`supabase/migrations/${migrationName}`)
const proof = read('supabase/migrations/__tests__/trader-series-publication-isolation.pg17.sh')
const partitionConvergence = read(
  'supabase/migrations/20260718135000_partition_child_rls_convergence.sql'
)
const packageJson = read('package.json')
const ciWorkflow = read('.github/workflows/ci.yml')

const withoutComments = (value: string): string =>
  value.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('trader-series publication isolation migration', () => {
  it('is a forward-only transactional metadata cutover', () => {
    expect(migrationName).toMatch(/^\d{14}_trader_series_publication_isolation\.sql$/)
    expect(migrationName > '20260817050000_arena_bot_legacy_publication_isolation.sql').toBe(true)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")

    const sql = withoutComments(migration)
    expect(sql).not.toMatch(/\b(?:CREATE|DROP)\s+TABLE\b/i)
    expect(sql).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE\s+arena\.trader_series|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/i
    )
    expect(sql).not.toContain('ALTER DEFAULT PRIVILEGES')
  })

  it('closes every daily descendant and refuses an ungoverned weekly partition topology', () => {
    expect(migration).toContain("'arena.trader_series'::pg_catalog.regclass::oid")
    expect(migration).toContain("'arena.trader_series_weekly'::pg_catalog.regclass::oid")
    expect(migration.match(/WITH RECURSIVE roots\(relid\)/g).length).toBeGreaterThanOrEqual(3)
    expect(migration).toContain('JOIN pg_catalog.pg_inherits AS inheritance')
    expect(migration).toContain("relation.relkind = 'r'")
    expect(migration).toContain('WHERE inheritance.inhparent = v_weekly')
    expect(migration).toContain('unpartitioned weekly table')
    expect(migration).toContain('LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain('ALTER TABLE %I.%I OWNER TO postgres')
    expect(migration).toContain('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('DROP POLICY %I ON %I.%I')
    expect(migration).toContain('attached relation retained a direct policy or ACL')
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)')
    expect(migration).toContain('has_any_column_privilege')

    // Future daily children are created only by this pre-existing, postgres
    // owned convergence helper. Weekly intentionally has no partition path.
    expect(partitionConvergence).toContain("'trader_series'")
    expect(partitionConvergence).toContain(
      'CREATE OR REPLACE FUNCTION arena.ensure_month_partitions'
    )
    expect(partitionConvergence).toContain('ALTER TABLE arena.%I ENABLE ROW LEVEL SECURITY')
    expect(partitionConvergence).toContain('REVOKE ALL ON TABLE arena.%I FROM PUBLIC')
    expect(partitionConvergence).toContain(
      'ALTER FUNCTION arena.ensure_month_partitions(text, integer, integer)'
    )
    expect(partitionConvergence).toContain('OWNER TO postgres')
  })

  it('restores only parent service CRUD and removes browser and delegated grants', () => {
    for (const table of ['arena.trader_series', 'arena.trader_series_weekly']) {
      expect(migration).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO service_role;`
      )
    }
    expect(migration).toMatch(
      /CREATE POLICY trader_series_service_role_only[\s\S]*?FOR ALL[\s\S]*?TO service_role[\s\S]*?USING \(true\)[\s\S]*?WITH CHECK \(true\);/
    )
    expect(migration).toMatch(
      /CREATE POLICY trader_series_weekly_service_role_only[\s\S]*?FOR ALL[\s\S]*?TO service_role[\s\S]*?USING \(true\)[\s\S]*?WITH CHECK \(true\);/
    )
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC CASCADE')
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM anon, authenticated, service_role CASCADE'
    )
    expect(migration).toContain('trader-series parent retained an unsafe table ACL')
    expect(migration).toContain('trader-series relation retained a non-owner column ACL')
    expect(migration).not.toMatch(
      /GRANT\s+[\s\S]{0,120}ON TABLE arena\.trader_series[\s\S]{0,120}TO\s+(?:PUBLIC|anon|authenticated)/i
    )
  })

  it('converges every raw-series RPC overload and preserves only explicit service callers', () => {
    for (const name of [
      'arena_roi_sparklines',
      'arena_core_modules',
      'snapshot_score_backtest',
      'evaluate_score_backtest',
    ]) {
      expect(migration).toContain(`'${name}'`)
    }
    expect(migration).toContain("namespace_row.nspname = 'public'")
    expect(migration).toContain("procedure.prokind = 'f'")
    expect(migration).toContain('pg_catalog.pg_get_function_identity_arguments(procedure.oid)')
    expect(migration).toContain("'ALTER FUNCTION %s OWNER TO postgres'")
    expect(migration).toContain("'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE'")
    expect(migration).toContain('trader-series legacy function retained an unsafe ACL')
    expect(migration).toContain(
      "'public.arena_core_modules(text,text,integer)'::pg_catalog.regprocedure::oid"
    )
    expect(migration).toContain("'public.snapshot_score_backtest()'::pg_catalog.regprocedure::oid")
    expect(migration).toContain(
      "'public.evaluate_score_backtest(integer)'::pg_catalog.regprocedure::oid"
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.arena_core_modules\(text, text, integer\) TO service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.snapshot_score_backtest\(\) TO service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.evaluate_score_backtest\(integer\) TO service_role;/
    )
    expect(migration).toContain('retired raw-series RPC remains executable by service_role')
  })

  it('attests the canonical gateway and complete role authority graph before and after the ACL rewrite', () => {
    for (const marker of [
      "v_authenticator oid := pg_catalog.to_regrole('authenticator')",
      "v_authenticator oid := 'authenticator'::pg_catalog.regrole",
      'membership.member = v_authenticator',
      'NOT membership.admin_option',
      'NOT membership.inherit_option',
      'membership.set_option',
      'role_row.rolsuper OR role_row.rolbypassrls',
      'trader-series service authority graph is unsafe',
      'trader-series service authority graph drifted after cutover',
      'trader-series browser role topology drifted after cutover',
    ]) {
      expect(migration).toContain(marker)
    }

    for (const graph of ['service_authority', 'postgres_authority', 'service_upstream']) {
      expect(migration.match(new RegExp(`WITH RECURSIVE ${graph}`, 'g'))).toHaveLength(2)
    }
    for (const role of ['anon', 'authenticated']) {
      expect(migration).toContain(`pg_catalog.pg_has_role('${role}', 'service_role', 'MEMBER')`)
      expect(migration).toContain(`pg_catalog.pg_has_role('${role}', 'postgres', 'MEMBER')`)
    }
  })

  it('ships an isolated PostgreSQL 17 proof and CI/package wiring', () => {
    for (const marker of [
      'trader-series-publication-isolation',
      'historical browser-readable fixture',
      'phantom core overload',
      'phantom sparkline overload',
      'anonymous direct SELECT is denied',
      'authenticated direct SELECT is denied',
      'inherited service-role reader',
      'multi-hop SET ROLE reader',
      'ADMIN-only bridge',
      'future monthly child',
      'PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
    expect(packageJson).toContain('"qa:trader-series-publication-isolation-pg17"')
    expect(ciWorkflow).toContain('run: npm run qa:trader-series-publication-isolation-pg17')
    expect(ciWorkflow).toContain('PG17_BIN: /usr/lib/postgresql/17/bin')
  })
})
