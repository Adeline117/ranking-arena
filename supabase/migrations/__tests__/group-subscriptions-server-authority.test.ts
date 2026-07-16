import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const migrationPath = join(
  root,
  'supabase/migrations/20260716172000_group_subscriptions_server_authority.sql'
)
const migration = readFileSync(migrationPath, 'utf8')

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sourceFilesBelow(path)
    return /\.(?:ts|tsx)$/.test(path) ? [path] : []
  })
}

describe('group subscriptions server authority migration', () => {
  it('is a bounded, locked transaction over the existing server-owned table', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(migration).toContain('LOCK TABLE public.group_subscriptions IN ACCESS EXCLUSIVE MODE')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on owner, shape, cascade, and inherited authority drift', () => {
    for (const column of [
      'group_id',
      'user_id',
      'tier',
      'status',
      'price_paid',
      'starts_at',
      'expires_at',
      'payment_provider',
      'payment_reference',
    ]) {
      expect(migration).toContain(`'${column}'`)
    }

    expect(migration).toContain('relation.relowner <> v_postgres_oid')
    expect(migration).toContain("constraint_row.confdeltype = 'c'")
    expect(migration).toContain('membership.inherit_option')
    expect(migration).toContain('membership.set_option')
    expect(migration).toContain("jwt_role.rolname IN ('anon', 'authenticated')")
    expect(migration).toContain('inherited.role_oid IN (v_service_oid, v_postgres_oid)')
  })

  it('dynamically removes every non-owner table/column ACL and policy', () => {
    expect(migration).toContain('DO $revoke_nonowner_acl$')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('discovered.grantee <> v_owner_oid')
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public.group_subscriptions FROM %s CASCADE'
    )
    expect(migration).toContain(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
    )
    expect(migration).toContain('DO $drop_all_subscription_policies$')
    expect(migration).toContain("'DROP POLICY %I ON public.group_subscriptions'")
  })

  it('leaves only exact service CRUD behind FORCE RLS', () => {
    expect(migration).toContain('ALTER TABLE public.group_subscriptions ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('ALTER TABLE public.group_subscriptions FORCE ROW LEVEL SECURITY')
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.group_subscriptions\s+TO service_role/
    )
    expect(migration).toMatch(
      /CREATE POLICY service_role_manages_group_subscriptions[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\)/
    )
    expect(migration).toContain("ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]")
    expect(migration).toContain('acl_entry.grantor <> v_postgres_oid')
    expect(migration).toContain('payment metadata remains browser-readable')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('guards the zero-browser-call assumption and the admin-client route', () => {
    const browserTableCallPattern = /\.from\(\s*['"]group_subscriptions['"]\s*\)/
    const tableCallers = [
      ...sourceFilesBelow(join(root, 'app')),
      ...sourceFilesBelow(join(root, 'lib')),
    ]
      .filter((path) => browserTableCallPattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path))
      .sort()

    expect(tableCallers).toEqual(['app/api/groups/subscribe/route.ts'])

    const route = readFileSync(join(root, 'app/api/groups/subscribe/route.ts'), 'utf8')
    const middleware = readFileSync(join(root, 'lib/api/middleware.ts'), 'utf8')

    expect(route).toContain("import { withAuth } from '@/lib/api/middleware'")
    expect(route.match(/export const (?:GET|POST|DELETE) = withAuth\(/g)).toHaveLength(3)
    expect(middleware).toMatch(
      /const supabase = getSupabaseAdmin\(\)[\s\S]*handler\(\{ user, supabase, request, version: versionContext \}\)/
    )
  })

  it('contains no application or presentation changes', () => {
    expect(migration).not.toMatch(/(?:jsx|tsx|className|grid-template|tailwind)/i)
  })
})
