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
    expect(migration).toContain('FROM PUBLIC, anon, authenticated')
    expect(migration).toContain(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)'
    )
    expect(migration).toContain('DROP POLICY %I ON public.group_applications')
    expect(migration).toContain('JWT privilege remains on group_applications')
    expect(migration).toContain('JWT policy remains on group_applications')
    expect(migration).not.toContain('CREATE VIEW public.own_group_applications')
  })

  it('keeps the base table and both atomic RPCs service-owned', () => {
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.group_applications TO service_role'
    )
    expect(migration).toContain('CREATE POLICY server_role_mutation')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.submit_group_application_atomic(')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.review_group_application_atomic(')
    expect(migration).toContain('atomic group-application RPC authority is incomplete')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")
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
