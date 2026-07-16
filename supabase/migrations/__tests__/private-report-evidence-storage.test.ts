import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716113800_private_report_evidence_storage.sql'),
  'utf8'
)

describe('private report evidence storage migration', () => {
  it('is transactional, lock-bounded, and fails a non-empty first install without deletion', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('private report evidence first install requires empty state')
    expect(migration).toContain('no evidence was changed')
    expect(migration).not.toMatch(/DELETE\s+FROM\s+(?:public\.content_reports|storage\.objects)/i)
    expect(migration).toContain('20260716112300_atomic_content_report_submission.sql')
    expect(migration).toContain('20260716114500 advisory-first post-interaction lock')
    expect(migration).toContain('apply 20260716112300_atomic_content_report_submission.sql first')
    expect(migration.indexOf('DO $preflight$')).toBeLessThan(
      migration.indexOf('LOCK TABLE public.content_reports')
    )
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('semantically proves the complete 112300 dependency before mutation and postflights it again', () => {
    expect(migration).toContain('explicit semantic dependency on 112300')
    expect(migration).toContain('relation.relrowsecurity')
    expect(migration).toContain('uniq_content_reports_pending_reporter_content')
    expect(migration).toContain("policy.polname = 'Service role manages content reports'")
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)')
    expect(migration).toContain('pg_catalog.has_table_privilege')
    expect(migration).toContain('pg_catalog.has_column_privilege')
    expect(migration).toContain("ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]")
    expect(migration).toContain("IS DISTINCT FROM '''pending''::text")
    expect(migration).toContain("IS DISTINCT FROM 'ARRAY[]::text[]'")
    for (const fragment of [
      "content_type = ANY (ARRAY[''post''::text",
      "reason = ANY (ARRAY[''spam''::text",
      "status = ANY (ARRAY[''pending''::text",
      'requires the canonical 112300 unique (id) key',
      'index_metadata.indimmediate',
    ]) {
      expect(migration).toContain(fragment)
    }
    expect(migration).toContain('DO $postflight$')
  })

  it('converges a private 2MB image-only reports bucket', () => {
    expect(migration).toMatch(
      /INSERT INTO storage\.buckets[\s\S]*'reports',[\s\S]*'reports',[\s\S]*false,[\s\S]*2097152/
    )
    for (const mime of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']) {
      expect(migration).toContain(`'${mime}'`)
    }
    expect(migration).toContain('ON CONFLICT (id) DO UPDATE SET')
    expect(migration).toContain('bucket.public IS false')
  })

  it('adds a restrictive browser deny while preserving service-only report access', () => {
    expect(migration).toMatch(
      /CREATE POLICY "Non-service roles cannot access report evidence"[\s\S]*AS RESTRICTIVE[\s\S]*TO PUBLIC[\s\S]*USING \(bucket_id <> 'reports' OR CURRENT_USER = 'service_role'\)[\s\S]*WITH CHECK \(bucket_id <> 'reports' OR CURRENT_USER = 'service_role'\)/
    )
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages report evidence"[\s\S]*TO service_role[\s\S]*USING \(bucket_id = 'reports'\)/
    )
    expect(migration).toContain('private report evidence RLS policy contract is invalid')
  })

  it('stores only unique reporter-owned server references', () => {
    expect(migration).toContain('content_reports_private_evidence_refs_check')
    expect(migration).toContain('content_report_evidence_refs_valid(reporter_id, images)')
    expect(migration).toContain('ALTER COLUMN images DROP DEFAULT')
    expect(migration).toContain('ALTER COLUMN images SET NOT NULL')
    expect(migration).toContain("'^reports/' || pg_catalog.lower(p_reporter_id::text)")
    expect(migration).toContain("'/[0-9a-f]{16}\\.(jpg|png|gif|webp|avif)$'")
    expect(migration).toContain('pg_catalog.count(DISTINCT evidence.ref)')
    expect(migration).not.toMatch(/https:\/\//)
    expect(migration).not.toMatch(/data:image/i)
  })

  it('installs a service-only upload registry with bounded reservation and leased cleanup', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.report_evidence_uploads')
    expect(migration).toContain("status IN ('reserved', 'uploaded', 'cleanup', 'claimed')")
    expect(migration).toContain(
      'ALTER TABLE public.report_evidence_uploads ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.report_evidence_uploads\s+TO service_role/
    )
    expect(migration).toContain('CREATE POLICY "Service role manages report evidence uploads"')
    expect(migration).toContain("'report-evidence-reserve:' || p_reporter_id::text")
    expect(migration).toContain('v_unclaimed_count >= 8')
    expect(migration).toContain("v_expires_at := pg_catalog.clock_timestamp() + INTERVAL '1 hour'")
    expect(migration).toContain('FOR UPDATE SKIP LOCKED')
    expect(migration).toContain(
      "v_lease_expires_at := pg_catalog.clock_timestamp() + INTERVAL '2 minutes'"
    )
    expect(migration).toContain('lease_stale_report_evidence_cleanup')
    expect(migration).toContain('registry constraint contract drift detected')
    expect(migration).toContain("constraint_row.contype = 'p'")
    expect(migration).toContain("constraint_row.contype = 'u'")
    expect(migration).toContain("constraint_row.contype = 'f'")
    expect(migration).toContain("constraint_row.confdeltype = 'n'")
    expect(migration).toContain('constraint_row.confdelsetcols IS NULL')
    expect(migration).toContain('object_name = substr(evidence_ref, 9)')
    expect(migration).toContain('report_evidence_uploads_lifecycle_check')
    expect(migration).toContain('attribute.attnotnull IS DISTINCT FROM expected.required_not_null')
    expect(migration).toContain("attribute.attgenerated <> ''")
    expect(migration).toContain("relation.relpersistence = 'p'")
    expect(migration).not.toMatch(/DELETE\s+FROM\s+storage\.objects/i)
  })

  it('turns deleted report claims into immediately leased cleanup orphans', () => {
    expect(migration).toContain(
      'report_id uuid REFERENCES public.content_reports(id) ON DELETE SET NULL'
    )
    expect(migration).toMatch(
      /status = 'claimed'\s+AND lease_token IS NULL\s+AND lease_expires_at IS NULL/
    )
    expect(migration).toContain("WHERE status <> 'claimed' OR report_id IS NULL")
    expect(migration).toMatch(/upload_row\.status = 'claimed'\s+AND upload_row\.report_id IS NULL/)
    expect(migration).toContain("IF v_status = 'claimed' AND v_report_id IS NOT NULL THEN")
    expect(migration).toMatch(
      /upload_row\.status = 'claimed'\s+AND upload_row\.report_id IS NOT NULL\s+AND NOT EXISTS/
    )
  })

  it('rewrites one fixed-path service RPC that proves every referenced object exists', () => {
    expect(migration).toContain('DO $drop_submit_content_report_overloads$')
    expect(migration).toMatch(
      /CREATE FUNCTION public\.submit_content_report\([\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain("object_row.bucket_id = 'reports'")
    expect(migration).toContain('object_row.name = v_object_name')
    expect(migration).toContain('report evidence object not found')
    expect(migration).toContain('FROM public.report_evidence_uploads AS upload_row')
    expect(migration).toMatch(
      /upload_row\.evidence_ref = ANY \(p_images\)[\s\S]*ORDER BY upload_row\.evidence_ref[\s\S]*FOR UPDATE/
    )
    expect(migration).toContain('v_locked_upload_count <> pg_catalog.cardinality(p_images)')
    expect(migration).toContain("SET status = 'claimed'")
    expect(migration).toContain('v_claimed_count <> pg_catalog.cardinality(p_images)')
    expect(migration).toContain("'reason', 'DUPLICATE_PENDING'")
    expect(migration).toContain('WHEN unique_violation THEN')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.submit_content_report\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.submit_content_report\([\s\S]*TO service_role/
    )
  })

  it('enters the advisory-first post boundary before locking post or comment targets', () => {
    expect(migration).toMatch(
      /WHEN 'post' THEN[\s\S]*lock_actor_can_interact_with_post\([\s\S]*SELECT post_row\.author_id[\s\S]*FOR SHARE/
    )
    expect(migration).toMatch(
      /WHEN 'comment' THEN[\s\S]*SELECT comment_row\.post_id[\s\S]*lock_actor_can_interact_with_post\([\s\S]*SELECT comment_row\.user_id, comment_row\.post_id[\s\S]*FOR SHARE[\s\S]*v_parent_post_id IS DISTINCT FROM v_candidate_post_id/
    )
  })

  it('postflights bucket, RLS, constraint, overload, owner, fixed path, and ACL catalogs', () => {
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('function_row.proowner = v_postgres_role_oid')
    expect(migration).toContain("function_row.provolatile = 'i'")
    expect(migration).toContain("function_row.provolatile = 'v'")
    expect(migration).toContain("ARRAY['search_path=pg_catalog, pg_temp']::text[]")
    expect(migration).toContain('pg_catalog.has_function_privilege')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('rechecks object/registry closure under locks and rejects TTL-invisible objects', () => {
    expect(migration).toContain('DO $lock_existing_registry$')
    expect(migration).toContain('DO $locked_evidence_recheck$')
    expect(migration).toContain('IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain('reports bucket contains an unregistered object')
    expect(migration).toMatch(
      /storage\.objects AS object_row[\s\S]*object_row\.bucket_id = 'reports'[\s\S]*NOT EXISTS \([\s\S]*public\.report_evidence_uploads AS upload_row[\s\S]*upload_row\.object_name = object_row\.name/
    )
  })
})
