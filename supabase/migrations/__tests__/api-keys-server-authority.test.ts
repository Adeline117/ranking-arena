import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const migrationName = '20260729010000_api_keys_server_authority.sql'
const migration = readFileSync(join(root, 'supabase/migrations', migrationName), 'utf8')
const pg17Proof = readFileSync(
  join(root, 'supabase/migrations/__tests__/api-keys-server-authority.pg17.sh'),
  'utf8'
)

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sourceFilesBelow(path)
    return /\.(?:ts|tsx)$/.test(path) ? [path] : []
  })
}

describe('API keys server authority migration', () => {
  it('is a bounded, locked transaction with an offline deployment contract', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(migration).toContain('LOCK TABLE public.api_keys, public.api_key_usage_daily')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on table, credential-column, role, and RPC drift', () => {
    for (const column of [
      'user_id',
      'key',
      'tier',
      'daily_limit',
      'request_count_today',
      'api_key_id',
      'request_count',
    ]) {
      expect(migration).toContain(`'${column}'`)
    }

    for (const routine of [
      'public.increment_api_key_usage(text)',
      'public.reset_api_key_daily_counts()',
      'public.rollup_api_key_usage()',
      'public.update_user_api_tier(uuid,text,text,integer)',
    ]) {
      expect(migration).toContain(routine)
    }

    expect(migration).toContain('ordinary permanent postgres-owned tables')
    expect(migration).toContain('contains an unreviewed overload')
    expect(migration).toContain('routine.prosecdef')
    expect(migration).toContain("ARRAY['search_path=public']::text[]")
    expect(migration).toContain('browser role inherits API key server authority')
  })

  it('removes unknown table, column, function, and policy authority drift', () => {
    expect(migration).toContain('DO $revoke_nonowner_table_acl$')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE %s FROM %s CASCADE')
    expect(migration).toContain("'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '")
    expect(migration).toContain('DO $drop_all_api_key_policies$')
    expect(migration).toContain("'DROP POLICY %I ON %s'")
    expect(migration).toContain('DO $revoke_nonowner_routine_acl$')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE')
  })

  it('leaves exact service CRUD, service EXECUTE, and two service policies', () => {
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.api_keys, public\.api_key_usage_daily\s+TO service_role/
    )
    expect(migration.match(/CREATE POLICY /g)).toHaveLength(2)
    expect(migration).toMatch(
      /CREATE POLICY service_role_manages_api_keys[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\)/
    )
    expect(migration).toMatch(
      /CREATE POLICY service_role_manages_api_key_usage_daily[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\)/
    )
    expect(migration.match(/GRANT EXECUTE\s+ON FUNCTION public\./g)).toHaveLength(4)
    expect(migration).toContain("ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]")
    expect(migration).toContain("ARRAY['EXECUTE']::text[]")
    expect(migration).toContain('has_table_privilege')
    expect(migration).toContain('has_column_privilege')
    expect(migration).toContain('has_function_privilege')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('normalizes RLS without forcing owner-executed maintenance jobs', () => {
    expect(migration).toContain('ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('ALTER TABLE public.api_key_usage_daily ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('ALTER TABLE public.api_keys NO FORCE ROW LEVEL SECURITY')
    expect(migration).toContain(
      'ALTER TABLE public.api_key_usage_daily NO FORCE ROW LEVEL SECURITY'
    )
    expect(migration).not.toMatch(
      /ALTER TABLE public\.(?:api_keys|api_key_usage_daily) FORCE ROW LEVEL SECURITY/
    )
  })

  it('keeps every direct application caller behind an admin-backed API route', () => {
    const directTablePattern = /\.from\(\s*['"](?:api_keys|api_key_usage_daily)['"]\s*\)/
    const directRpcPattern =
      /\.rpc\(\s*['"](?:increment_api_key_usage|reset_api_key_daily_counts|rollup_api_key_usage|update_user_api_tier)['"]/
    const callers = [...sourceFilesBelow(join(root, 'app')), ...sourceFilesBelow(join(root, 'lib'))]
      .filter((path) => {
        const source = readFileSync(path, 'utf8')
        return directTablePattern.test(source) || directRpcPattern.test(source)
      })
      .map((path) => relative(root, path))
      .sort()

    expect(callers).toEqual([
      'app/api/user/api-keys/route.ts',
      'app/api/user/api-keys/usage/route.ts',
      'app/api/v3/route.ts',
    ])

    const keyRoute = readFileSync(join(root, 'app/api/user/api-keys/route.ts'), 'utf8')
    const usageRoute = readFileSync(join(root, 'app/api/user/api-keys/usage/route.ts'), 'utf8')
    const v3Route = readFileSync(join(root, 'app/api/v3/route.ts'), 'utf8')
    const stripeShared = readFileSync(
      join(root, 'app/api/stripe/webhook/handlers/shared.ts'),
      'utf8'
    )
    const middleware = readFileSync(join(root, 'lib/api/middleware.ts'), 'utf8')

    expect(keyRoute).toContain("import { withAuth } from '@/lib/api/middleware'")
    expect(usageRoute).toContain("import { withAuth } from '@/lib/api/middleware'")
    expect(v3Route).toContain("import { getSupabaseAdmin } from '@/lib/supabase/server'")
    expect(stripeShared).toContain('export const getSupabase = () => getSupabaseAdmin()')
    expect(middleware).toMatch(
      /const supabase = getSupabaseAdmin\(\)[\s\S]*handler\(\{ user, supabase, request, version: versionContext \}\)/
    )
  })

  it('proves the exploit, browser denial, NOBYPASS service path, and replay', () => {
    expect(pg17Proof).toContain('browser pre-boundary privilege proof failed')
    expect(pg17Proof).toContain('authenticated can read the full API key')
    expect(pg17Proof).toContain('authenticated can manufacture pro unlimited')
    expect(pg17Proof).toContain('anon can forge API tier through PUBLIC definer execute')
    expect(pg17Proof).toContain('authenticated direct table access remained')
    expect(pg17Proof).toContain('authenticated API key RPC execute remained')
    expect(pg17Proof).toContain('anon API tier definer execute remained')
    expect(pg17Proof).toContain('service_role NOBYPASSRLS route proof failed')
    expect(pg17Proof).toContain('hostile ACL replay did not converge')
    expect(pg17Proof).toContain('API keys server authority PG17 proof passed')
  })
})
