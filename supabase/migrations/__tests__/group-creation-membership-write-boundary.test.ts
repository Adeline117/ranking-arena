import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260716111800_group_creation_membership_write_boundary.sql'
  ),
  'utf8'
)
const groupPage = readFileSync(join(process.cwd(), 'app/(app)/groups/[id]/page.tsx'), 'utf8')
const groupsFeed = readFileSync(
  join(process.cwd(), 'app/components/groups/GroupsFeedPage.tsx'),
  'utf8'
)
const membershipRoute = readFileSync(
  join(process.cwd(), 'app/api/groups/[id]/membership/route.ts'),
  'utf8'
)
const apiMiddleware = readFileSync(join(process.cwd(), 'lib/api/middleware.ts'), 'utf8')

describe('group creation and membership server-write boundary', () => {
  it('fails closed before taking both bounded table locks in runtime order', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '90s'")
    expect(migration).toContain(
      "pg_catalog.hashtextextended('group-application-authority-migrations', 0)"
    )
    expect(migration).toContain("pg_catalog.to_regclass('public.groups')")
    expect(migration).toContain("pg_catalog.to_regclass('public.group_members')")
    expect(migration).toContain("pg_catalog.pg_get_userbyid(relation.relowner) = 'postgres'")
    expect(migration).toContain("relation.relkind IN ('r', 'p')")
    expect(migration).toContain('required group table columns are missing')

    const preflight = migration.indexOf('DO $preflight$')
    const lock = migration.indexOf(
      'LOCK TABLE public.groups, public.group_members IN ACCESS EXCLUSIVE MODE'
    )
    const policyReplacement = migration.indexOf('DO $replace_group_authority_policies$')
    const aclReplacement = migration.indexOf('DO $replace_group_authority_acls$')
    expect(preflight).toBeGreaterThan(0)
    expect(lock).toBeGreaterThan(preflight)
    expect(policyReplacement).toBeGreaterThan(lock)
    expect(aclReplacement).toBeGreaterThan(policyReplacement)
  })

  it('preserves browser discovery/member reads and makes both tables service-write-only', () => {
    expect(migration).toContain('GRANT SELECT ON TABLE public.groups TO anon, authenticated')
    expect(migration).toContain('GRANT SELECT ON TABLE public.group_members TO anon, authenticated')
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.groups TO service_role'
    )
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.group_members TO service_role'
    )
    expect(migration.match(/CREATE POLICY browser_read/g)).toHaveLength(2)
    expect(migration.match(/CREATE POLICY server_role_mutation/g)).toHaveLength(2)
    expect(migration.match(/FOR SELECT\n  TO anon, authenticated\n  USING \(true\)/g)).toHaveLength(
      2
    )
    expect(migration.match(/FOR ALL\n  TO service_role\n  USING \(true\)/g)).toHaveLength(2)
  })

  it('converges arbitrary table, column and policy drift to exact ACLs', () => {
    expect(migration).toContain('DROP POLICY %I ON public.%I')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I')
    expect(migration).toContain(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)'
    )
    expect(migration).toContain(
      "IS DISTINCT FROM ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]"
    )
    expect(migration).toContain('unexpected or grantable group table ACL remains')
    expect(migration).toContain('nonowner group column ACL remains')
    expect(migration).toContain('group policy boundary is not exact')
    expect(migration).toContain("policy.polname = 'browser_read'")
    expect(migration).toContain("policy.polname = 'server_role_mutation'")
    expect(migration).toContain(
      "pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true) = 'true'"
    )
    expect(migration).toContain(
      "pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true) = 'true'"
    )
  })

  it('matches the live browser read and service membership paths without UI changes', () => {
    expect(groupPage).toContain(".from('groups')")
    expect(groupPage).toContain(".from('group_members')")
    expect(groupsFeed).toContain(".from('group_members')")
    expect(groupPage).toContain('`/api/groups/${groupId}/membership`')
    expect(groupPage).not.toMatch(
      /\.from\(['"]group_members['"]\)[\s\S]{0,120}\.(?:insert|update|delete|upsert)\(/
    )
    expect(membershipRoute).toMatch(/export const POST = withAuth\(/)
    expect(membershipRoute).toContain("'mutate_group_membership_atomic'")
    expect(membershipRoute).toContain("'redeem_group_invite_atomic'")
    expect(membershipRoute).not.toMatch(/\.from\(['"]group_members['"]\)/)
    expect(apiMiddleware).toContain('const supabase = getSupabaseAdmin() as SupabaseClient')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")
  })
})
