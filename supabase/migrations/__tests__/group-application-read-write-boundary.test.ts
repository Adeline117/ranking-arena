import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260716111700_group_application_read_write_boundary.sql'
  ),
  'utf8'
)
const applicantRoute = readFileSync(join(process.cwd(), 'app/api/groups/apply/route.ts'), 'utf8')
const approveRoute = readFileSync(
  join(process.cwd(), 'app/api/groups/applications/[id]/approve/route.ts'),
  'utf8'
)
const rejectRoute = readFileSync(
  join(process.cwd(), 'app/api/groups/applications/[id]/reject/route.ts'),
  'utf8'
)
const apiMiddleware = readFileSync(join(process.cwd(), 'lib/api/middleware.ts'), 'utf8')

describe('group application read/write boundary', () => {
  it('bounds waits, takes the shared advisory lock and locks the table before ACL changes', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '90s'")
    expect(migration).toContain(
      "pg_catalog.hashtextextended('group-application-authority-migrations', 0)"
    )

    const tableLock = migration.indexOf(
      'LOCK TABLE public.group_applications IN ACCESS EXCLUSIVE MODE'
    )
    const firstPolicyChange = migration.indexOf('DROP VIEW IF EXISTS public.own_group_applications')
    const firstAclChange = migration.indexOf('REVOKE ALL PRIVILEGES ON public.group_applications')
    expect(tableLock).toBeGreaterThan(0)
    expect(firstPolicyChange).toBeGreaterThan(tableLock)
    expect(firstAclChange).toBeGreaterThan(tableLock)
  })

  it('requires the service-only atomic RPC boundary first', () => {
    expect(migration).toContain(
      'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean)'
    )
    expect(migration).toContain(
      'public.review_group_application_atomic(uuid,uuid,text,text,boolean)'
    )
    expect(migration).toContain(
      'atomic group-application boundary must exist before its ACL lockdown'
    )
  })

  it('removes every browser table, column and policy write path', () => {
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON public.group_applications')
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role')
    expect(migration).toContain(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)'
    )
    expect(migration).toContain('DROP POLICY %I ON public.group_applications')
    expect(migration).toContain('JWT privilege remains on group_applications')
    expect(migration).toContain('JWT policy remains on group_applications')
    expect(migration).toContain('nonowner column ACL remains on group_applications')
    expect(migration).toContain("'TRUNCATE,REFERENCES,TRIGGER'")
    expect(migration).not.toContain('CREATE VIEW public.own_group_applications')
  })

  it('keeps the base table and both atomic RPCs service-owned', () => {
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.group_applications TO service_role'
    )
    expect(migration).toContain('CREATE POLICY server_role_mutation')
    expect(migration).toContain('policy.polpermissive')
    expect(migration).toContain('policy.polroles = ARRAY[service_role_oid]::oid[]')
    expect(migration).toContain(
      "pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true) = 'true'"
    )
    expect(migration).toContain(
      "pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true) = 'true'"
    )
    expect(migration).toContain(
      "IS DISTINCT FROM ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]"
    )
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.submit_group_application_atomic(')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.review_group_application_atomic(')
    expect(migration).toContain('atomic group-application RPC authority is not service-only')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")
  })

  it('removes legacy overloads and rejects every noncanonical function entry point', () => {
    expect(migration).toMatch(
      /DROP FUNCTION IF EXISTS public\.submit_group_application_atomic\([\s\S]*?jsonb, text, boolean\s*\);/
    )
    expect(migration).toMatch(
      /DROP FUNCTION IF EXISTS public\.review_group_application_atomic\(\s*uuid, uuid, text, text\s*\);/
    )
    expect(migration).toContain("procedure.proname = 'submit_group_application_atomic'")
    expect(migration).toContain("procedure.proname = 'review_group_application_atomic'")
    expect(migration).toContain('procedure.proowner <> postgres_role_oid')
    expect(migration).toContain('NOT procedure.prosecdef')
    expect(migration).toContain('acl.grantee NOT IN (postgres_role_oid, service_role_oid)')
  })

  it('can be applied before the route cutover because every legacy table call is service-side', () => {
    expect(apiMiddleware).toContain('const supabase = getSupabaseAdmin() as SupabaseClient')
    expect(applicantRoute).toMatch(/export const POST = withAuth\(/)
    expect(applicantRoute).toMatch(/export const GET = withAuth\(/)
    expect(applicantRoute).toContain(".from('group_applications')")

    for (const reviewRoute of [approveRoute, rejectRoute]) {
      expect(reviewRoute).toContain('const supabase = getSupabaseAdmin()')
      expect(reviewRoute).toContain('verifyAdmin(supabase')
    }
  })
})
