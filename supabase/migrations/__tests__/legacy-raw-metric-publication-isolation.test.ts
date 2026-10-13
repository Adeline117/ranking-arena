import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

const migrationName = '20260817061000_legacy_raw_metric_publication_isolation.sql'
const migration = read(`supabase/migrations/${migrationName}`)
const proof = read('supabase/migrations/__tests__/legacy-raw-metric-publication-isolation.pg17.sh')
const packageJson = read('package.json')
const ciWorkflow = read('.github/workflows/ci.yml')

const rawRelations = [
  'trader_daily_snapshots',
  'trader_equity_curve',
  'trader_timeseries',
  'trader_portfolio',
  'trader_asset_breakdown',
  'trader_stats_detail',
  'trader_roi_history',
  'trader_positions_live',
  'trader_positions_history',
  'trader_position_summary',
]

const withoutComments = (value: string): string =>
  value.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('legacy raw metric publication isolation migration', () => {
  it('is a forward-only transactional metadata cutover', () => {
    expect(migrationName).toMatch(/^\d{14}_legacy_raw_metric_publication_isolation\.sql$/)
    expect(migrationName > '20260817060000_trader_series_publication_isolation.sql').toBe(true)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")

    const sql = withoutComments(migration)
    expect(sql).not.toMatch(/\b(?:CREATE|DROP)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)/i)
    expect(sql).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE\s+public\.trader_|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/i
    )
    expect(sql).not.toContain('ALTER DEFAULT PRIVILEGES')
  })

  it('covers the exact legacy raw relation inventory, including positions and portfolio cost basis', () => {
    for (const relation of rawRelations) {
      expect(migration).toContain(`'public.${relation}'`)
    }
    expect(migration).toContain("v_kind NOT IN ('r', 'p')")
    expect(migration).toContain('legacy raw metric isolation requires a table or partitioned table')
    expect(migration.match(/WITH RECURSIVE roots\(root_relid, relid\)/g)).toHaveLength(5)
    expect(migration).toContain('JOIN pg_catalog.pg_inherits AS inheritance')
    expect(migration).toContain(
      'legacy raw metric isolation refuses cross-schema attached relations'
    )
    expect(migration).toContain('LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE')
  })

  it('converges every current root and attached child to a service-only database surface', () => {
    expect(migration).toContain('ALTER TABLE %I.%I OWNER TO postgres')
    expect(migration).toContain('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('DROP POLICY %I ON %I.%I')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC CASCADE')
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM anon, authenticated, service_role CASCADE'
    )
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)')
    expect(migration).toContain('raw_legacy_metric_service_only')
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I\.%I TO service_role/
    )
    expect(migration).toContain('legacy raw metric child retains direct service access')
    expect(migration).toContain('legacy_raw_metric_partition_child_convergence')
    expect(migration).toContain('converge_legacy_raw_metric_partition_children')
    expect(migration).toContain('WHERE tree.root_relid <> tree.relid')
    expect(migration).toContain(
      "set_config('arena.legacy_raw_metric_partition_converging', 'off', true)"
    )
    expect(migration).toContain(
      'requires a superuser migration executor for partition event triggers'
    )
    expect(migration).toContain(
      'legacy raw metric attached relation retained a direct policy or ACL'
    )
    expect(migration).toContain('has_any_column_privilege')
    expect(migration).not.toMatch(
      /GRANT\s+[\s\S]{0,140}ON TABLE[\s\S]{0,140}TO\s+(?:PUBLIC|anon|authenticated)/i
    )
  })

  it('seals every public raw-reader RPC overload to service execution only', () => {
    expect(migration).toContain("namespace_row.nspname = 'public'")
    expect(migration).toContain("procedure.prokind = 'f'")
    expect(migration).toContain('pg_catalog.pg_get_functiondef(procedure.oid)')
    expect(migration).toContain('pg_catalog.pg_get_function_identity_arguments(procedure.oid)')
    expect(migration).toContain("'ALTER FUNCTION %s OWNER TO postgres'")
    expect(migration).toContain("'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE'")
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION %s TO service_role')
    expect(migration).toContain('legacy raw metric public function ACL did not converge')
  })

  it('attests the role graph before and after ACL convergence', () => {
    for (const marker of [
      "v_authenticator oid := pg_catalog.to_regrole('authenticator')",
      "v_authenticator oid := 'authenticator'::pg_catalog.regrole",
      'membership.member = v_authenticator',
      'NOT membership.admin_option',
      'NOT membership.inherit_option',
      'membership.set_option',
      'role_row.rolsuper OR role_row.rolbypassrls',
      'legacy raw metric service authority graph is unsafe',
      'legacy raw metric service authority graph drifted after cutover',
      'legacy raw metric service role posture is unsafe',
      'legacy raw metric service role posture drifted after cutover',
    ]) {
      expect(migration).toContain(marker)
    }

    for (const graph of ['service_authority', 'postgres_authority', 'service_upstream']) {
      expect(migration.match(new RegExp(`WITH RECURSIVE ${graph}`, 'g'))).toHaveLength(2)
    }
    expect(migration).toContain("dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass")
    for (const role of ['anon', 'authenticated']) {
      expect(migration).toContain(`pg_catalog.pg_has_role('${role}', 'service_role', 'MEMBER')`)
      expect(migration).toContain(`pg_catalog.pg_has_role('${role}', 'postgres', 'MEMBER')`)
    }
  })

  it('ships an isolated PostgreSQL 17 proof and CI/package wiring', () => {
    for (const marker of [
      'legacy-raw-metric-publication-isolation',
      'historical browser-readable fixture',
      'trader_timeseries_y2026m08',
      'historical authenticated partition child read',
      'anonymous-canonical-raw-rpc',
      'authenticated-overload-raw-rpc',
      'inherited-service-role-reader',
      'multi-hop-set-reader',
      'admin-only-gateway-delegator',
      'trader_timeseries_y2026m09',
      'trader_timeseries_y2026m10',
      'ATTACH PARTITION public.trader_timeseries_y2026m10',
      'BEGIN;',
      'PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
    expect(packageJson).toContain('"qa:legacy-raw-metric-publication-isolation-pg17"')
    expect(ciWorkflow).toContain('run: npm run qa:legacy-raw-metric-publication-isolation-pg17')
    expect(ciWorkflow).toContain('PG17_BIN: /usr/lib/postgresql/17/bin')
  })
})
