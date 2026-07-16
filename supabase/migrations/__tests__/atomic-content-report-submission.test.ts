import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716112300_atomic_content_report_submission.sql'),
  'utf8'
)

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sourceFilesBelow(path)
    return /\.(?:ts|tsx)$/.test(path) ? [path] : []
  })
}

describe('atomic content report submission migration', () => {
  it('is bounded, transactional, and documents the database-first rollout', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('before either report route switches')
    expect(migration).toContain('legacy /api/report contract')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on schema drift and never silently deletes duplicate evidence', () => {
    for (const relation of [
      'content_reports',
      'posts',
      'comments',
      'conversations',
      'user_profiles',
    ]) {
      expect(migration).toContain(`'${relation}'`)
    }
    expect(migration).toContain("'public.lock_actor_can_interact_with_post(uuid,uuid)'")
    expect(migration).toContain('content_reports status/images defaults are incompatible')
    expect(migration).toContain('content_reports is missing canonical check constraint')
    expect(migration).toContain("status = ANY (ARRAY[''pending''::text")
    expect(migration).toContain("''dismissed''::text])")
    expect(migration).toContain('HAVING pg_catalog.count(*) > 1')
    expect(migration).toContain('duplicate pending reporter/content groups')
    expect(migration).not.toMatch(/DELETE FROM public\.content_reports[\s\S]*status = 'pending'/)
    expect(migration.indexOf('DO $preflight$')).toBeLessThan(
      migration.indexOf('LOCK TABLE public.content_reports')
    )
  })

  it('installs the exact pending-only reporter/content uniqueness invariant', () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS\s+uniq_content_reports_pending_reporter_content\s+ON public\.content_reports \(reporter_id, content_type, content_id\)\s+WHERE status = 'pending'/
    )
    for (const fragment of [
      'index_metadata.indisunique',
      'index_metadata.indisvalid',
      'index_metadata.indisready',
      "ARRAY['reporter_id', 'content_type', 'content_id']::name[]",
      "= '(status = ''pending''::text)'",
    ]) {
      expect(migration).toContain(fragment)
    }
  })

  it('makes report storage service-only at table, column, and policy layers', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.content_reports\s+FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain('DO $revoke_nonowner_report_table_access$')
    expect(migration).toContain('DO $revoke_column_privileges$')
    expect(migration).toContain('DO $drop_report_policies$')
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.content_reports\s+TO service_role/
    )
    expect(migration.match(/CREATE POLICY /g)).toHaveLength(1)
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages content reports"[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\)/
    )
  })

  it('publishes one fixed-path, service-only atomic submission RPC', () => {
    expect(migration).toMatch(
      /CREATE FUNCTION public\.submit_content_report\([\s\S]*p_reporter_id uuid,[\s\S]*p_content_type text,[\s\S]*p_content_id uuid,[\s\S]*p_reason text,[\s\S]*p_description text DEFAULT NULL,[\s\S]*p_images text\[\] DEFAULT ARRAY\[\]::text\[\][\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.submit_content_report\([\s\S]*\) FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.submit_content_report\([\s\S]*\) TO service_role/
    )
    expect(migration).toMatch(
      /ALTER FUNCTION public\.submit_content_report\([\s\S]*\) OWNER TO postgres/
    )
  })

  it('validates canonical 2C input, bounded HTTPS evidence, and active reporters', () => {
    expect(migration).toContain("p_content_type NOT IN ('post', 'comment', 'message', 'user')")
    for (const reason of [
      'spam',
      'harassment',
      'inappropriate',
      'misinformation',
      'fraud',
      'other',
    ]) {
      expect(migration).toContain(`'${reason}'`)
    }
    expect(migration).toContain('pg_catalog.char_length(v_description) NOT BETWEEN 15 AND 1000')
    expect(migration).toContain('pg_catalog.cardinality(p_images) NOT BETWEEN 1 AND 4')
    expect(migration).toContain('pg_catalog.char_length(v_image) NOT BETWEEN 1 AND 2048')
    expect(migration).toContain("v_image !~ '^https://[^[:space:]]+$'")
    expect(migration).toContain('reporter.banned_at IS NULL')
    expect(migration).toContain('reporter.deleted_at IS NULL')
  })

  it('authorizes every canonical target without exposing inaccessible rows', () => {
    expect(migration).toContain("WHEN 'post' THEN")
    expect(migration).toContain("WHEN 'comment' THEN")
    expect(migration).toContain("WHEN 'user' THEN")
    expect(migration).toContain("WHEN 'message' THEN")
    expect(migration).toContain(
      'public.lock_actor_can_interact_with_post(p_content_id, p_reporter_id)'
    )
    expect(migration).toContain('comment_row.deleted_at IS NULL')
    expect(migration).toContain('cannot report own profile')
    expect(migration).toContain('p_reporter_id NOT IN (v_user1_id, v_user2_id)')
    expect(migration).toContain('report target is unavailable')
  })

  it('returns a stable duplicate result for RPC and legacy insert races', () => {
    expect(migration).toContain("'reason', 'DUPLICATE_PENDING'")
    expect(migration).toContain('WHEN unique_violation THEN')
    expect(migration).toMatch(
      /INSERT INTO public\.content_reports[\s\S]*RETURNING id INTO v_report_id/
    )
    expect(migration).toMatch(
      /'created', true,[\s\S]*'report_id', v_report_id,[\s\S]*'status', 'pending'/
    )
  })

  it('strictly postflights ACL, policy, index, signature, defaults, and grants', () => {
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('pg_catalog.has_table_privilege')
    expect(migration).toContain('pg_catalog.has_column_privilege')
    expect(migration).toContain('pg_catalog.has_function_privilege')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('policy.polroles = ARRAY[v_service_role_oid]::oid[]')
    expect(migration).toContain('content report table ACL is not exact service CRUD')
    expect(migration).toContain('nonowner column ACL remains on public.content_reports')
    expect(migration).toContain('function_row.proowner = v_postgres_role_oid')
    expect(migration).toContain('function_row.pronargdefaults = 2')
    expect(migration).toContain("function_row.prorettype = 'jsonb'::regtype")
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('proves every current content-report table caller is server-routed', () => {
    const reportTableSources = sourceFilesBelow(join(process.cwd(), 'app'))
      .filter((path) => /\.from\(\s*['"]content_reports['"]\s*\)/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(process.cwd(), path))
      .sort()

    expect(reportTableSources).toEqual(
      [
        'app/api/admin/moderation-queue/route.ts',
        'app/api/admin/reports/[id]/resolve/route.ts',
        'app/api/admin/reports/route.ts',
        'app/api/admin/stats/route.ts',
        'app/api/report/route.ts',
        'app/api/reports/route.ts',
      ].sort()
    )

    for (const path of reportTableSources) {
      expect(path).toMatch(/^app\/api\//)
    }

    expect(readFileSync(join(process.cwd(), 'lib/api/middleware.ts'), 'utf8')).toContain(
      'const supabase = getSupabaseAdmin() as SupabaseClient'
    )
    expect(readFileSync(join(process.cwd(), 'lib/api/with-admin-auth.ts'), 'utf8')).toContain(
      'getSupabaseAdmin()'
    )
  })
})
