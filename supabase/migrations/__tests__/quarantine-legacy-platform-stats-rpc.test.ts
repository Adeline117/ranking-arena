import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migrationDir = join(root, 'supabase/migrations')
const migrationName = '20260817134214_quarantine_legacy_platform_stats_rpc.sql'
const migration = readFileSync(join(migrationDir, migrationName), 'utf8')
const proof = readFileSync(
  join(migrationDir, '__tests__/quarantine-legacy-platform-stats-rpc.pg17.sh'),
  'utf8'
)
const packageJson = readFileSync(join(root, 'package.json'), 'utf8')
const ciWorkflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')

describe('legacy platform-statistics RPC quarantine migration', () => {
  it('is a transactional, forward-only ACL cutover rather than a replacement RPC', () => {
    expect(migrationName).toMatch(/^\d{14}_quarantine_legacy_platform_stats_rpc\.sql$/)
    expect(migrationName > '20260817061000_legacy_raw_metric_publication_isolation.sql').toBe(true)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'")
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")
    expect(migration).not.toMatch(/CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\b/i)
    expect(migration).not.toMatch(/DROP\s+FUNCTION\b/i)
  })

  it('does not pretend the repository has a canonical get_platform_stats definition', () => {
    const currentDefinitions = readdirSync(migrationDir)
      .filter((file) => file.endsWith('.sql'))
      .filter((file) => file !== migrationName)
      .filter((file) =>
        /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+public\.get_platform_stats\s*\(/i.test(
          readFileSync(join(migrationDir, file), 'utf8')
        )
      )

    expect(currentDefinitions).toEqual([])
    expect(
      readFileSync(join(migrationDir, '20260413183428_fix_function_search_path.sql'), 'utf8')
    ).toContain('ALTER FUNCTION public.get_platform_stats SET search_path = public, pg_temp;')
  })

  it('fails closed without a live overload and dynamically revokes every function overload', () => {
    expect(migration).toContain("procedure.proname = 'get_platform_stats'")
    expect(migration).toContain("procedure.prokind = 'f'")
    expect(migration).toContain('requires at least one public.get_platform_stats function overload')
    expect(migration).toContain('procedure.oid::pg_catalog.regprocedure AS signature')
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role'
    )
    expect(migration).not.toContain("to_regprocedure('public.get_platform_stats(text)')")
  })

  it('proves both direct PUBLIC and effective application-role execution are closed', () => {
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain('privilege.grantee = 0')
    expect(migration).toContain("privilege.privilege_type = 'EXECUTE'")
    expect(migration).toContain('pg_catalog.has_function_privilege(')
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(migration).toContain(`('${role}'::name)`)
    }
    expect(migration).toContain('remains executable by PUBLIC')
    expect(migration).toContain('remains executable by an application role')
  })

  it('ships a disposable PostgreSQL 17 proof and CI/package wiring', () => {
    for (const marker of [
      'no-live-overload-fails-closed',
      'get_platform_stats(p_season_id text)',
      'p_include_archived boolean',
      'GRANT EXECUTE ON FUNCTION public.get_platform_stats(text)',
      'PUBLIC, anon, authenticated, service_role',
      'prove replay stability',
      'anon-text-overload-denied',
      'authenticated-two-argument-overload-denied',
      'service-role-text-overload-denied',
      'PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
    expect(packageJson).toContain('"qa:legacy-platform-stats-rpc-pg17"')
    expect(ciWorkflow).toContain('run: npm run qa:legacy-platform-stats-rpc-pg17')
    expect(ciWorkflow).toContain('PG17_BIN: /usr/lib/postgresql/17/bin')
  })
})
