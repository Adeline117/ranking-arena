/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260803111000_post_media_claims.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/__tests__/post-media-claims.pg17.sh'),
  'utf8'
)

function functionBody(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`
  const start = migration.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf('$function$;', start)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end + '$function$;'.length)
}

describe('post media claim expansion', () => {
  it('is inert, additive and bounded', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration).toContain('-- Phase: predeploy.')
    expect(migration).toContain("hashtextextended('public-post-media-claims@1', 0)")
    expect(migration).toContain('No current API calls these new')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|CONSTRAINT)\b/i)
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?storage\./i)
    expect(migration).not.toMatch(/\b(?:lease|release|gc_admit|garbage_collect)_post_media/i)
    expect(migration).not.toMatch(/UPDATE\s+public\.post_media_uploads/i)
  })

  it('adds two private FORCE-RLS tables without owner or target cascades', () => {
    for (const table of ['post_media_claim_sets', 'post_media_claims']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`)
      expect(migration).toContain(`ALTER TABLE public.${table} OWNER TO postgres`)
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`)
    }
    expect(migration.match(/\) USING heap;/g)).toHaveLength(2)
    for (const marker of [
      'scope text NOT NULL',
      'operation_id uuid NOT NULL',
      'requested_revision bigint',
      'target_revision bigint',
      'manifest_fingerprint text NOT NULL',
      'intent_fingerprint text NOT NULL',
      'object_count integer NOT NULL',
      'result jsonb NOT NULL',
      'PRIMARY KEY (scope, operation_id)',
      'PRIMARY KEY (upload_id, target_kind, target_id)',
      'first_claim_operation_id uuid NOT NULL',
      'first_seen_revision bigint',
      'last_seen_revision bigint',
      'ON UPDATE RESTRICT ON DELETE RESTRICT',
    ]) {
      expect(migration).toContain(marker)
    }
    expect(migration).not.toContain('ON DELETE CASCADE')
    expect(migration).not.toContain('REFERENCES auth.users')
    expect(migration).not.toContain('REFERENCES public.posts')
    expect(migration).toContain('object_count BETWEEN 0 AND 64')
    expect(migration).toContain('pg_catalog.pg_column_size(result) BETWEEN 2 AND 262144')
    expect(migration).toContain("target_kind IN ('post', 'group_application', 'group')")
  })

  it('dynamically removes table, column, policy and routine authority', () => {
    expect(migration).toContain('DO $converge_private_table_acl$')
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)')
    expect(migration).toContain('DROP POLICY %I ON %s')
    expect(migration).toContain('DO $converge_function_acl$')
    expect(migration).toContain('REVOKE ALL ON FUNCTION %s FROM %I CASCADE')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION %s TO service_role')
    expect(migration).toContain('DO $postflight$')
    expect(migration).not.toMatch(/GRANT\s+[^;]+ON TABLE public\.post_media_claim/i)
  })

  it('keeps the internal claim composer owner-only and exposes only new names', () => {
    const internal = functionBody('claim_post_media_manifest_internal')
    expect(internal).toContain('SECURITY DEFINER')
    expect(internal).toContain('SET row_security = off')
    expect(migration).toContain(
      "'public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)', false"
    )
    for (const name of [
      'create_post_with_media_claims_atomic',
      'edit_post_with_media_claims_atomic',
      'submit_group_application_with_media_claims_atomic',
      'review_group_application_with_media_claims_atomic',
    ]) {
      expect(functionBody(name)).toContain('service role required')
      expect(functionBody(name)).toContain('SECURITY DEFINER')
      expect(functionBody(name)).toContain('pg_try_advisory_xact_lock_shared')
      expect(functionBody(name)).toContain('post media claims migration is active')
    }
    expect(migration.match(/service role required/g)).toHaveLength(4)
    expect(migration.match(/pg_try_advisory_xact_lock_shared/g)).toHaveLength(4)
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.(?:create_post_atomic|edit_post_atomic|submit_group_application_atomic|review_group_application_atomic)/
    )
  })

  it('locks every upload id, then object identity, then rows', () => {
    const internal = functionBody('claim_post_media_manifest_internal')
    const uploadLock = internal.indexOf("'post-media-upload-id:'")
    const objectLock = internal.indexOf("'post-media-object:'")
    const rowLock = internal.indexOf('FOR UPDATE;', objectLock)
    expect(uploadLock).toBeGreaterThan(0)
    expect(objectLock).toBeGreaterThan(uploadLock)
    expect(rowLock).toBeGreaterThan(objectLock)
    expect(internal).toContain('ORDER BY upload_row.upload_id')
    expect(internal).toContain('ORDER BY lock_name.object_name COLLATE "C"')
    expect(internal).toContain('Global media lock order is immutable')
    const storageLock = internal.indexOf('FROM storage.objects AS storage_row')
    expect(storageLock).toBeGreaterThan(rowLock)
    expect(internal).toContain('FOR SHARE;')
    const lockedRowCount = internal.indexOf(
      'GET DIAGNOSTICS v_storage_count = ROW_COUNT;',
      storageLock
    )
    expect(lockedRowCount).toBeGreaterThan(storageLock)
    expect(internal.indexOf('IF v_storage_count IS DISTINCT FROM', storageLock)).toBeGreaterThan(
      lockedRowCount
    )
  })

  it('requires an exact referenced, uploaded, owner-bound manifest', () => {
    const internal = functionBody('claim_post_media_manifest_internal')
    expect(internal).toContain("'post-media-claim-manifest:v1'")
    expect(internal).toContain('v_registered_refs IS DISTINCT FROM v_manifest')
    expect(internal).toContain('p_intent_fingerprint IS NULL')
    expect(internal).toContain("v_upload.status IS DISTINCT FROM 'uploaded'")
    expect(internal).toContain('v_upload.gc_admitted_at IS NOT NULL')
    expect(internal).toContain('v_upload.owner_id IS DISTINCT FROM p_media_owner_id')
    expect(internal).toContain('v_referenced_names IS DISTINCT FROM v_manifest')
    expect(internal).toContain('post media Storage object is unavailable')
    expect(internal).not.toMatch(/expires_at\s*[<>=]/)
    expect(internal).toContain("v_upload.purpose IN ('post_image', 'legacy_image')")
    expect(internal).toContain("v_upload.purpose = 'post_video'")
    expect(internal).toContain("v_upload.purpose IN ('group_avatar', 'legacy_image')")
    expect(internal).toContain('NOT v_upload.object_name = ANY(v_image_refs)')
    expect(internal).toContain('post media manifest does not exactly match registered references')
  })

  it('binds managed references to one canonical trusted origin', () => {
    const internal = functionBody('claim_post_media_manifest_internal')
    expect(internal).toContain('p_storage_origin text')
    expect(internal).toContain(
      "v_media_prefix := p_storage_origin || '/storage/v1/object/public/posts/'"
    )
    expect(internal).toContain('malformed canonical post media reference')
    expect(internal).toContain('v_origin_scheme')
    expect(internal).toContain('v_origin_authority')
    expect(internal).toContain("':0*443$'")
    expect(internal).toContain("'^https?://[^/]*@'")
    expect(internal).toContain('v_storage_stem')
    expect(internal).toContain("'(https?://[^[:space:]<>\"''`()\\[\\]]+)', 'gi'")
    for (const name of [
      'create_post_with_media_claims_atomic',
      'edit_post_with_media_claims_atomic',
      'submit_group_application_with_media_claims_atomic',
      'review_group_application_with_media_claims_atomic',
    ]) {
      const body = functionBody(name)
      expect(body).toContain('p_storage_origin text')
      expect(body).toContain('p_storage_origin IS DISTINCT FROM')
      expect(body).toContain('p_storage_origin')
    }
  })

  it('writes empty manifests and exact replay records, raising on conflicts', () => {
    const internal = functionBody('claim_post_media_manifest_internal')
    expect(internal).toContain('COALESCE')
    expect(internal).toContain('ARRAY[]::text[]')
    expect(internal).toContain('INSERT INTO public.post_media_claim_sets')
    expect(internal).toContain('RETURN v_existing.result')
    expect(internal).toContain("ERRCODE = '22023'")
    expect(internal).toContain('post media claim operation conflict')
    const edit = functionBody('edit_post_with_media_claims_atomic')
    expect(edit).toContain('RETURN v_existing.result')
    expect(edit).toContain('v_existing.requested_revision IS DISTINCT FROM p_expected_version')
    expect(edit).toContain('v_existing.intent_fingerprint IS DISTINCT FROM v_intent_fingerprint')
  })

  it('composes old authorities before claims so a raised claim rolls all work back', () => {
    const cases = [
      [
        'create_post_with_media_claims_atomic',
        'public.create_post_atomic(',
        "'post_create'",
        false,
      ],
      ['edit_post_with_media_claims_atomic', 'public.edit_post_atomic(', "'post_edit'", true],
      [
        'submit_group_application_with_media_claims_atomic',
        'public.submit_group_application_atomic(',
        "'group_submit'",
        false,
      ],
      [
        'review_group_application_with_media_claims_atomic',
        'public.review_group_application_atomic(',
        "'group_review'",
        false,
      ],
    ] as const
    for (const [name, oldCall, scope, storedReplayFirst] of cases) {
      const body = functionBody(name)
      const oldAuthority = body.indexOf(oldCall)
      const claimLookup = body.indexOf('FROM public.post_media_claim_sets')
      const claim = body.lastIndexOf('public.claim_post_media_manifest_internal(')
      expect(oldAuthority).toBeGreaterThan(0)
      if (storedReplayFirst) expect(claimLookup).toBeLessThan(oldAuthority)
      else expect(claimLookup).toBeGreaterThan(oldAuthority)
      expect(claim).toBeGreaterThan(oldAuthority)
      expect(body).toContain(scope)
      expect(body).not.toMatch(/\bCOMMIT\b/)
    }
  })

  it('copies approved group claims while preserving the application target', () => {
    const review = functionBody('review_group_application_with_media_claims_atomic')
    expect(review).toContain("claim_row.target_kind = 'group_application'")
    expect(review).toContain("claim_row.reference_kind = 'group_avatar'")
    expect(review).toContain("v_target_kind := 'group'")
    expect(review).toContain("v_target_kind := 'group_application'")
    expect(review).toContain('v_manifest := ARRAY[v_avatar_object_name]')
    const internal = functionBody('claim_post_media_manifest_internal')
    expect(internal).toContain('p_source_application_id')
    expect(internal).toContain("target_kind = 'group_application'")
    expect(internal).toContain('reviewed application and group media references conflict')
    expect(internal).toContain('approved group application link conflict')
    expect(internal).toContain("v_source_status IS DISTINCT FROM 'approved'")
    expect(internal).toContain('v_source_group_id IS DISTINCT FROM p_target_id')
    expect(review).not.toMatch(/DELETE\s+FROM\s+public\.post_media_claims/i)
    expect(migration).toContain('PRIMARY KEY (upload_id, target_kind, target_id)')
  })

  it('pins PG17 catalog, role graph and dependency authority contracts', () => {
    expect(migration).toContain('post_media_claim_tables_are_exact()')
    expect(migration).toContain('post_media_claim_role_graph_is_safe()')
    expect(migration).toContain('post_media_upload_registry_is_exact()')
    expect(migration).toContain('post_media_upload_authorities_are_safe()')
    expect(migration).toContain('post_media_claim_authorities_are_safe()')
    expect(migration).toContain('post_media_claim_publication_is_exact()')
    expect(migration).toContain('post_media_claim_existing_tables_fingerprint(')
    expect(migration).toContain('post_media_claim_fk_triggers_are_safe(')
    expect(migration).toContain('pg_catalog.pg_get_constraintdef')
    expect(migration).toContain('pg_catalog.pg_get_indexdef')
    expect(migration).toContain('pg_catalog.pg_get_function_arguments')
    expect(migration).toContain('attribute.attisdropped')
    expect(migration).toContain('attribute.attstorage')
    expect(migration).toContain('relation.relam')
    expect(migration).toContain("access_method.amname = 'heap'")
    expect(migration).toContain('actual.tgconstrindid IS DISTINCT FROM')
    expect(migration).toContain('function_row.proargdefaults')
    expect(migration).toContain('function_row.prosqlbody')
    expect(migration).toContain("'16ce55b402e98e4decb1e044dcd2f881'")
    expect(migration).toContain("'56e6f09a800136a55e4249b2cf1ba9c4'")
    expect(migration).toContain(
      "'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])'"
    )
    expect(migration).toContain('post media claim table publication is partial')
    expect(migration).toContain('post media claim publication is partial or unsafe')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('has a real PostgreSQL 17 adversarial proof', () => {
    expect(pg17Proof).toContain('postgresql@17')
    expect(pg17Proof).toContain('post-media-upload-registry.sql')
    expect(pg17Proof).toContain('post_media_claim_sets')
    expect(pg17Proof).toContain('post_media_claims')
    expect(pg17Proof).toContain('SET ROLE service_role')
    expect(pg17Proof).toContain('exact_edit_replay')
    expect(pg17Proof).toContain('manifest_conflict')
    expect(pg17Proof).toContain('claim_failure_rolls_back_create')
    expect(pg17Proof).toContain('OLD_APPROVE_APP')
    expect(pg17Proof).toContain('OLD_REJECT_APP')
    expect(pg17Proof).toContain('MIXED_REVIEW_OP')
    expect(pg17Proof).toContain('storage_missing_create')
    expect(pg17Proof).toContain('storage_missing_edit')
    expect(pg17Proof).toContain('storage_missing_submit')
    expect(pg17Proof).toContain('storage_missing_review')
    expect(pg17Proof).toContain('unregistered_canonical')
    expect(pg17Proof).toContain('malformed_default_port')
    expect(pg17Proof).toContain('malformed_userinfo')
    expect(pg17Proof).toContain('malformed_encoded_posts')
    expect(pg17Proof).toContain('malformed_encoded_host')
    expect(pg17Proof).toContain('malformed_padded_port')
    expect(pg17Proof).toContain('malformed_backslash')
    expect(pg17Proof).toContain('video_in_images')
    expect(pg17Proof).toContain('unknown_set_member')
    expect(pg17Proof).toContain('registry_source_drift')
    expect(pg17Proof).toContain('publication_synchronized_source_drift')
    expect(pg17Proof).toContain('publication_default_drift')
    expect(pg17Proof).toContain('publication_acl_drift')
    expect(pg17Proof).toContain('disabled_fk_trigger')
    expect(pg17Proof).toContain('claim_storage_drift')
    expect(pg17Proof).toContain('claim_dropped_tombstone')
    expect(pg17Proof).toContain('claim_acl_drift')
    expect(pg17Proof).toContain('registry_acl_drift')
    expect(pg17Proof).toContain('partial_table_publication')
    expect(pg17Proof).toContain('claim_extra_constraint')
    expect(pg17Proof).toContain('concurrent_same_operation')
    expect(pg17Proof).toContain('media_claim_lock_holder')
    expect(pg17Proof).toContain('media_claim_legacy_holder')
    expect(pg17Proof).toContain('active_runtime_migration_lock')
    expect(pg17Proof).toContain('wrong_group_ack')
    expect(pg17Proof).toContain('bad_updated_revision_ack')
    expect(pg17Proof).toContain('LOST_EDIT_CLAIM_OP')
    expect(pg17Proof).toContain('EDIT_RESULT_AFTER_ADVANCE')
    expect(pg17Proof).toContain('null_intent_fingerprint')
    expect(pg17Proof).toContain('OLD_REJECT_FIRST_EXPECTED')
    expect(pg17Proof).toContain('private_acl')
  })
})
