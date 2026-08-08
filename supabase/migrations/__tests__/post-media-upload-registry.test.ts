/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260803110000_post_media_upload_registry.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/__tests__/post-media-upload-registry.pg17.sh'),
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

describe('post media upload registry expansion', () => {
  it('is a bounded, inert predeploy transaction', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration).toContain('-- Phase: predeploy.')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("hashtextextended('public-post-media-upload-registry@1', 0)")
    expect(migration).toContain('does not change any upload route')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)

    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+(?:public\.)?post_media_uploads\b/i)
    expect(migration).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?storage\.objects\b/i
    )
    expect(migration).not.toMatch(
      /\b(?:pg_cron|cron\.schedule|lease_post_media|claim_post_media)\b/i
    )
  })

  it('creates the exact private registry without an owner cascade', () => {
    const tableStart = migration.indexOf('CREATE TABLE IF NOT EXISTS public.post_media_uploads')
    const tableEnd = migration.indexOf('\n);', tableStart)
    const table = migration.slice(tableStart, tableEnd)

    for (const marker of [
      'upload_id uuid NOT NULL',
      'owner_id uuid NOT NULL',
      'object_name text NOT NULL',
      'CONSTRAINT post_media_uploads_pkey PRIMARY KEY (upload_id)',
      'CONSTRAINT post_media_uploads_object_name_key UNIQUE (object_name)',
      "purpose IN ('post_image', 'post_video', 'group_avatar', 'legacy_image')",
      "status IN ('reserved', 'uploaded')",
      'expires_at timestamptz NOT NULL',
      'created_at timestamptz NOT NULL',
      'updated_at timestamptz NOT NULL',
      'gc_admitted_at timestamptz',
      'gc_admitted_at IS NULL',
    ]) {
      expect(table).toContain(marker)
    }
    expect(table).not.toContain('REFERENCES auth.users')
    expect(table).not.toContain('ON DELETE CASCADE')
    expect(migration).toContain('ALTER TABLE public.post_media_uploads OWNER TO postgres')
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('ON public.post_media_uploads (status, expires_at, upload_id)')
  })

  it('binds purpose, MIME, size, path and finite lifetime at the table', () => {
    for (const mime of [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/avif',
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'video/x-matroska',
      'video/x-msvideo',
    ]) {
      expect(migration).toContain(`'${mime}'`)
    }
    expect(migration).toContain('size_bytes BETWEEN 1 AND 5242880')
    expect(migration).toContain('size_bytes BETWEEN 1 AND 104857600')
    expect(migration).toContain('pg_catalog.octet_length(object_name) BETWEEN 1 AND 512')
    expect(migration).toContain("object_name !~ '[[:cntrl:]]'")
    expect(migration).toContain("'^' || pg_catalog.lower(owner_id::text)")
    expect(migration).toContain(
      "|| '/videos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'"
    )
    expect(migration).toContain("|| '\\.(jpg|png|gif|webp|avif)$'")
    expect(migration).toContain("|| '\\.(mp4|mov|webm|mkv|avi)$'")
    expect(migration).toContain(
      "mime_type = 'image/jpeg' AND pg_catalog.right(object_name, 4) = '.jpg'"
    )
    expect(migration).toContain(
      "mime_type = 'video/quicktime' AND pg_catalog.right(object_name, 4) = '.mov'"
    )
    expect(migration).toContain(
      "mime_type = 'video/x-matroska' AND pg_catalog.right(object_name, 4) = '.mkv'"
    )
    expect(migration).toContain('pg_catalog.isfinite(expires_at)')
    expect(migration).toContain('expires_at > created_at')
    expect(migration).toContain('updated_at >= created_at')
  })

  it('converges unknown table, column, policy and function authority', () => {
    expect(migration).toContain('DO $converge_registry_acl$')
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)')
    expect(migration).toContain('FROM %2$I CASCADE')
    expect(migration).toContain('DO $drop_registry_policies$')
    expect(migration).toContain('DO $converge_function_acl$')
    expect(migration).toContain('REVOKE ALL ON FUNCTION %s FROM %I CASCADE')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION %s TO service_role')
    expect(migration).toContain('post media upload registry ACL/RLS convergence failed')
    expect(migration).not.toMatch(/GRANT\s+[^;]+ON TABLE public\.post_media_uploads/i)
  })

  it('audits recursive PostgreSQL 17 SET and INHERIT role paths', () => {
    expect(migration).toContain('pg_temp.post_media_registry_role_graph_is_safe()')
    expect(migration).toContain('WITH RECURSIVE protected_root AS')
    expect(migration).toContain('pg_catalog.pg_auth_members AS membership')
    expect(migration).toContain('membership.inherit_option')
    expect(migration).toContain('membership.set_option')
    expect(migration).toContain('membership.admin_option')
    expect(migration).toContain('membership_path.depth = 1')
    expect(migration).toContain('AND NOT membership_path.inherit_option')
    expect(migration).toContain('AND NOT membership_path.admin_option')
    expect(migration).toContain('WHERE NOT membership.roleid = ANY (membership_path.visited)')
    expect(migration).toContain("protected_root.origin_name IN ('anon', 'authenticated')")
    expect(migration).toContain("reachable_role.rolname IN ('service_role', 'postgres')")
    expect(migration).toContain("membership_path.origin_name = 'authenticator'")
    expect(migration).toContain('service_authority AS (')
    expect(migration).toContain('service_inherits AS (')
    expect(migration).toContain('membership.member NOT IN (')
    expect(migration).toContain("role_row.rolname = 'cli_login_postgres'")
    expect(migration).toContain('AND role_row.rolcanlogin')
    expect(migration).toContain('AND NOT role_row.rolcreaterole')
    expect(migration).toContain('SELECT 1 FROM service_inherits')
    expect(migration).toContain('post media upload registry role graph is unsafe')
    expect(migration.match(/post_media_registry_role_graph_is_safe\(\)/g)).toHaveLength(3)
    expect(migration).not.toContain('pg_catalog.pg_has_role')
  })

  it('rejects every user trigger before definer publication and again postflight', () => {
    const shape = migration.indexOf('DO $table_shape_preflight$')
    const firstTrigger = migration.indexOf('FROM pg_catalog.pg_trigger AS trigger_row', shape)
    const reservePublication = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.reserve_post_media_upload_atomic'
    )
    const postflight = migration.indexOf('DO $postflight$')
    const secondTrigger = migration.indexOf('FROM pg_catalog.pg_trigger AS trigger_row', postflight)
    expect(firstTrigger).toBeGreaterThan(shape)
    expect(firstTrigger).toBeLessThan(reservePublication)
    expect(secondTrigger).toBeGreaterThan(postflight)
    expect(migration.match(/AND NOT trigger_row\.tgisinternal/g)).toHaveLength(2)
    expect(migration).not.toContain('trigger_row.tgenabled')
  })

  it('publishes only service-definer reserve and finalize authorities with seals', () => {
    for (const signature of [
      'public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
      'public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
    ]) {
      expect(migration).toContain(signature)
    }
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(2)
    expect(migration.match(/SET row_security = off/g)).toHaveLength(2)
    expect(migration).toContain('DO $seal_registry_functions$')
    expect(migration).toContain('post-media-upload-registry:reserve-v1:')
    expect(migration).toContain('post-media-upload-registry:finalize-v1:')
    expect(migration).toContain('existing post media upload registry function source seal drifted')
    expect(migration).toContain('incompatible post media upload registry overload exists')
  })

  it.each(['reserve_post_media_upload_atomic', 'finalize_post_media_upload_atomic'])(
    '%s authenticates before validation, locks, or private reads',
    (name) => {
      const body = functionBody(name)
      const auth = body.indexOf('service role required')
      const validation = body.indexOf('invalid post media upload')
      const lock = body.indexOf('post-media-upload-id:')
      const registry = body.indexOf('FROM public.post_media_uploads')
      expect(auth).toBeGreaterThan(0)
      expect(validation).toBeGreaterThan(auth)
      expect(body).toContain('OR p_purpose IS NULL')
      expect(lock).toBeGreaterThan(validation)
      expect(registry).toBeGreaterThan(lock)
    }
  )

  it('reserves exact immutable identities with server-owned expiry and replay', () => {
    const reserve = functionBody('reserve_post_media_upload_atomic')
    expect(reserve).toContain("'post-media-upload-id:'")
    expect(reserve).toContain("'post-media-object:'")
    expect(reserve).toContain('FOR UPDATE')
    expect(reserve).toContain('reservation identity conflict')
    expect(reserve).toContain('object identity conflict')
    expect(reserve).toContain('FROM auth.users AS owner_account')
    expect(reserve).toContain("v_expires_at := v_now + interval '1 hour'")
    expect(reserve).toContain("'replayed', true")
    expect(reserve).toContain("'replayed', false")
    expect(reserve).toContain("'expires_at', v_existing.expires_at")
    expect(reserve).toContain("v_existing.status = 'reserved'")
    expect(reserve).toContain('v_existing.expires_at <= pg_catalog.statement_timestamp()')
    expect(reserve).toContain('post media upload reservation expired')
    expect(reserve).toContain("'^' || pg_catalog.lower(p_owner_id::text)")
    expect(reserve).not.toContain('storage.objects')
  })

  it('finalizes only exact unexpired posts-bucket objects and replays safely', () => {
    const finalize = functionBody('finalize_post_media_upload_atomic')
    const identity = finalize.indexOf('finalization identity conflict')
    const expiry = finalize.indexOf('reservation expired')
    const storage = finalize.indexOf('FROM storage.objects AS object_row')
    const update = finalize.indexOf('UPDATE public.post_media_uploads')
    expect(identity).toBeGreaterThan(0)
    expect(expiry).toBeGreaterThan(identity)
    expect(storage).toBeGreaterThan(expiry)
    expect(update).toBeGreaterThan(storage)
    expect(finalize).toContain("object_row.bucket_id = 'posts'")
    expect(finalize).toContain('object_row.name = v_upload.object_name')
    expect(finalize).toContain("v_replayed := v_upload.status = 'uploaded'")
    expect(finalize).toContain('IF NOT v_replayed THEN')
    expect(finalize).not.toMatch(/\bDELETE\b/)
  })

  it('fails closed on exact catalog shape, dependency and ACL drift', () => {
    for (const marker of [
      'post media upload registry dependency columns drifted',
      'storage.objects bucket/name identity is not unique',
      'canonical posts bucket is required',
      'post media upload registry role graph is unsafe',
      'post media upload registry table shape drifted',
      'post media upload registry index shape drifted',
      'post media upload registry function contract failed',
    ]) {
      expect(migration).toContain(marker)
    }
    expect(migration).toContain("constraint_row.contype = 'f'")
    expect(migration).toContain('attribute.attname NOT IN')
    expect(migration).toContain('pg_catalog.pg_get_constraintdef(constraint_row.oid, true)')
    expect(migration).toContain("'675ed1dfca4b0e465550cc52151b706d'")
    expect(migration).toContain("'b607d427abf640dd52d74f07b780542b'")
    expect(migration).toContain('pg_catalog.pg_get_indexdef(index_row.indexrelid)')
    expect(migration).toContain("'83876798b71ac8054d76c9e09709dea4'")
    expect(migration).toContain('pg_catalog.cardinality(function_row.proconfig) = 4')
  })

  it('ships executable PG17 replay, drift, identity, expiry, and privacy proofs', () => {
    for (const marker of [
      'private_service_only_shape',
      'reservation_idempotency',
      'storage_identity_mismatch',
      'expiry_fence',
      'owner_lifecycle_retention',
      'hostile_acl_and_ownership_replay',
      'canonical_authenticator_set_edge',
      'missing_canonical_authenticator_edge',
      'authenticator_admin_edge',
      'unknown_service_member_set_only',
      'unknown_service_member_admin_only',
      'anon_set_only_service_path',
      'recursive_authenticated_bypass_path',
      'authenticator_high_privilege_path',
      'service_super_path',
      'hostile_disabled_trigger_drift',
      'null_purpose_no_constraint_oracle',
      'owner_bound_server_paths',
      'uploaded_replay_survives_expiry',
      'expired_reservation_replay_fence',
      'concurrent_same_upload_different_identity',
      'concurrent_different_upload_same_object',
      'table_shape_drift',
      'same_name_check_body_drift',
      'expiry_index_definition_drift',
      'function_source_seal_drift',
      'migration_replay_with_data',
      'post media upload registry PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
