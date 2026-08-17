/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260803112000_post_media_coverage_inventory.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/__tests__/post-media-coverage-inventory.pg17.sh'),
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

function tableBody(name: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS public.${name}`
  const start = migration.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf(') USING heap;', start)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end + ') USING heap;'.length)
}

describe('post media historical coverage inventory', () => {
  it('is PREDEPLOY, additive, observe-only, and has no application caller', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration).toContain('-- Phase: predeploy.')
    expect(migration).toContain('No application calls these names')
    expect(migration).toContain("hashtextextended('public-post-media-claims@1', 0)")
    expect(migration).toContain("hashtextextended('public-post-media-coverage@1', 0)")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|CONSTRAINT)\b/i)
    expect(migration).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(?:posts|groups|group_applications|post_media_uploads|post_media_claim_sets|post_media_claims)\b/i
    )
    expect(migration).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+storage\./i)
    expect(migration).not.toMatch(
      /\b(?:claim|release|lease|gc_admit|garbage_collect)_post_media\b/i
    )
  })

  it('publishes exactly five private permanent FORCE-RLS heap tables', () => {
    const tables = [
      'post_media_coverage_config',
      'post_media_coverage_runs',
      'post_media_coverage_targets',
      'post_media_coverage_attempts',
      'post_media_coverage_references',
    ]
    for (const table of tables) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`)
      expect(migration).toContain(`ALTER TABLE public.${table} OWNER TO postgres`)
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`)
    }
    expect(migration.match(/\) USING heap;/g)).toHaveLength(5)
    expect(migration).toContain('DO $converge_private_table_acl$')
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)')
    expect(migration).toContain('DROP POLICY %I ON %s')
    expect(migration).not.toMatch(/GRANT\s+[^;]+ON TABLE public\.post_media_coverage/i)
  })

  it('pins complete table, dependency, RI, ACL, role-graph, and publication catalogs', () => {
    expect(migration).toContain('post_media_coverage_tables_are_exact()')
    expect(migration).toContain(') <> 23 OR EXISTS (')
    expect(migration).toContain(') <> 13 OR EXISTS (')
    expect(migration).toContain('pg_catalog.pg_get_constraintdef(constraint_row.oid,true)')
    expect(migration).toContain('pg_catalog.pg_get_indexdef(index_row.indexrelid)')
    expect(migration).toContain('constraint_row.conkey IS DISTINCT FROM expected.conkey')
    expect(migration).toContain('constraint_row.confkey IS DISTINCT FROM expected.confkey')
    expect(migration).toContain('post_media_coverage_upload_dependency_is_exact()')
    expect(migration).toContain('post_media_coverage_claim_dependencies_are_exact()')
    expect(migration).toContain('post_media_coverage_claim_fk_triggers_are_safe(')
    expect(migration).toContain('post_media_upload_authorities_are_safe()')
    expect(migration).toContain('post_media_claim_publication_is_exact()')
    expect(migration).toContain('post_media_coverage_foundations_are_exact()')
    expect(migration).toContain('pg_catalog.pg_inherits')
    expect(migration).toContain("operator_class.opcname='uuid_ops'")
    expect(migration).toContain("operator_class.opcname='text_ops'")
    expect(migration).toContain('post_media_coverage_role_graph_is_safe()')
    expect(migration).toContain('WITH RECURSIVE protected_root')
    expect(migration).toContain('), membership_path AS (')
    expect(migration).toContain('post_media_coverage_publication_is_exact()')
  })

  it('keeps the trusted origin immutable and classifies official direct hosts closed', () => {
    const config = tableBody('post_media_coverage_config')
    expect(config).toContain('config_id = 1')
    expect(config).toContain('revision = 1')
    expect(config).toContain("classifier_version = 'pg-lexical-v1'")
    expect(config).not.toMatch(/\bDEFAULT\b/)
    const install = functionBody('install_post_media_coverage_origin_atomic')
    expect(install).toContain("SESSION_USER <> 'postgres'")
    expect(install).toContain('post media coverage origin is immutable')
    expect(install).toContain('invalid canonical post media Storage origin')
    const classifier = functionBody('classify_post_media_reference_lexical_internal')
    expect(classifier).toContain("'canonical_managed'")
    expect(classifier).toContain("'external'")
    expect(classifier).toContain("'malformed_or_ambiguous'")
    expect(classifier).toContain('whatwg_ambiguous')
    expect(classifier).toContain('noncanonical_internal_reference')
    expect(classifier).toContain('managed_owner_unavailable')
    expect(classifier).toContain("U&'[\\00A0\\1680\\2000-\\200A")
    expect(classifier).toContain("v_storage_host ~ '^[a-z0-9-]+\\.supabase\\.co$'")
    expect(classifier).toContain("'.storage.supabase.co'")
    expect(classifier).toContain("'/storage/v1/object/public/posts/'")
    expect(classifier).toContain('pg_catalog.octet_length(p_reference) > 2048')
    expect(classifier).toContain('p_reference_kind IS NULL')
    expect(classifier).not.toMatch(/\b(?:url_parse|whatwg_url)_/i)
  })

  it('uses nullable-start keysets and strictly bounded source materialization', () => {
    const runs = tableBody('post_media_coverage_runs')
    expect(runs).toContain('cursor_started boolean NOT NULL')
    const enqueue = functionBody('enqueue_post_media_coverage_inventory_atomic')
    expect(enqueue).toContain('p_limit NOT BETWEEN 1 AND 500')
    expect(enqueue).toContain('NOT v_run.cursor_started OR post_row.id > v_run.cursor_id')
    expect(enqueue).toContain('NOT v_run.cursor_started OR app_row.id > v_run.cursor_id')
    expect(enqueue).toContain('NOT v_run.cursor_started OR group_row.id > v_run.cursor_id')
    expect(enqueue).toContain('pg_catalog.pg_column_compression(post_row.images) IS NOT NULL')
    expect(enqueue).toContain("'oversized-post-v2'")
    expect(enqueue).toContain("'oversized-application-v1'")
    expect(enqueue).toContain("'oversized-group-v1'")
    const observe = functionBody('observe_post_media_coverage_inventory_atomic')
    expect(observe).toContain('p_limit NOT BETWEEN 1 AND 25')
    expect(observe).toContain('FOR UPDATE OF target_row SKIP LOCKED')
    expect(observe).toContain('source_reference_budget_exceeded')
    expect(observe).toContain('reference_limit_exceeded')
    expect(observe).toContain('pg_catalog.pg_column_compression(post_row.images) IS NOT NULL')
    expect(observe).toContain('FROM pg_catalog.unnest(CASE')
    expect(observe).toContain('bounded.reference_ordinal<=65')
    expect(observe).toContain('normalized_source.content')
    expect(observe).toContain('source_present boolean NOT NULL')
    expect(observe).toContain('FOR SHARE OF post_row NOWAIT')
    expect(observe).toContain('AND NOT batch.source_present')
    expect(observe).toContain('linked_group.id=ANY(v_locked_group_ids)')
    expect(observe).toContain("'oversized-status:'")
    expect(observe).toContain('WHEN app_row.avatar_url IS NULL THEN false')
    expect(observe).toContain(
      "WHEN application_target.source_status='approved' AND group_row.id IS NOT NULL THEN"
    )
  })

  it('extracts renderer tokens without alt-text or full-token double counting', () => {
    const observe = functionBody('observe_post_media_coverage_inventory_atomic')
    expect(observe).toContain('$image$!\\[([^\\]\\r\\n]*)\\]\\(([^)\\r\\n]+)\\)$image$')
    expect(observe).toContain('$link$(?<!!)\\[([^\\]\\r\\n]*)\\]\\(([^)\\r\\n]+)\\)$link$')
    expect(observe).toContain('image_raw.value[1] IS DISTINCT FROM image_token.value[2]')
    expect(observe).toContain('link_destination_raw.value[1] IS DISTINCT FROM link_token.value[2]')
    expect(observe).toContain('$raw$(https?://[^[:space:]<>"{}|\\\\^`\\[\\]]+)$raw$')
    expect(observe).toContain('video_in_images')
    expect(observe).toContain("'post_video' ELSE 'post_image'")
  })

  it('stores immutable per-attempt snapshots and only bounded reference hashes', () => {
    const attempts = tableBody('post_media_coverage_attempts')
    expect(attempts).toContain('PRIMARY KEY (run_id,target_kind,target_id,attempt)')
    expect(attempts).toContain('source_fingerprint text NOT NULL')
    expect(attempts).toContain('link_fingerprint text NOT NULL')
    expect(attempts).toContain('manifest_fingerprint text')
    expect(attempts).toContain('observed_at timestamptz')
    const references = tableBody('post_media_coverage_references')
    expect(references).toContain('raw_sha256 text NOT NULL')
    expect(references).toContain('raw_length integer NOT NULL')
    expect(references).not.toContain('raw_reference')
    expect(references).toContain(
      'REFERENCES public.post_media_coverage_attempts(run_id,target_kind,target_id,attempt)'
    )
    expect(migration.match(/ON UPDATE RESTRICT ON DELETE RESTRICT/g)).toHaveLength(3)
    expect(migration).not.toContain('ON DELETE CASCADE')
    const observe = functionBody('observe_post_media_coverage_inventory_atomic')
    expect(observe).toContain('reference_key text NOT NULL')
    expect(observe).toContain('PRIMARY KEY(target_kind,target_id,reference_key)')
    expect(observe.indexOf('INSERT INTO public.post_media_coverage_attempts')).toBeLessThan(
      observe.indexOf('INSERT INTO public.post_media_coverage_references')
    )
    expect(observe).toContain(
      "pg_catalog.sha256(pg_catalog.convert_to(reference_row.raw_reference,'UTF8'))"
    )
  })

  it('locks complete business batches before sorted media identity and evidence', () => {
    const observe = functionBody('observe_post_media_coverage_inventory_atomic')
    const businessLock = Math.max(
      observe.indexOf('FOR SHARE OF post_row'),
      observe.indexOf('FOR SHARE OF app_row'),
      observe.indexOf('FOR SHARE OF group_row')
    )
    const uploadAdvisory = observe.indexOf("'post-media-upload-id:'")
    const objectAdvisory = observe.indexOf("'post-media-object:'")
    const registryLock = observe.indexOf('FOR SHARE OF upload_row')
    const storageLock = observe.indexOf('FOR SHARE OF storage_row')
    const claimLock = observe.indexOf('FOR SHARE OF claim_row')
    const evidenceWrite = observe.indexOf('INSERT INTO public.post_media_coverage_references')
    expect(businessLock).toBeGreaterThan(0)
    expect(uploadAdvisory).toBeGreaterThan(businessLock)
    expect(objectAdvisory).toBeGreaterThan(uploadAdvisory)
    expect(registryLock).toBeGreaterThan(objectAdvisory)
    expect(storageLock).toBeGreaterThan(registryLock)
    expect(claimLock).toBeGreaterThan(storageLock)
    expect(evidenceWrite).toBeGreaterThan(claimLock)
    expect(observe).toContain('ORDER BY upload_row.upload_id')
    expect(observe).toContain('ORDER BY reference_row.object_name COLLATE "C"')
  })

  it('seals only a persistent historical snapshot and exposes no cutover/GC authority', () => {
    const seal = functionBody('seal_post_media_coverage_inventory_atomic')
    expect(seal).toContain('persistent keyset fold over immutable observed summaries')
    expect(seal).toContain('target_row.target_id>v_run.cursor_id')
    expect(seal).toContain('LIMIT p_limit')
    expect(seal).toContain("'target-v1'")
    expect(seal).toContain("pg_catalog.date_part('epoch',v_target.observed_at)")
    expect(seal).toContain("state=CASE WHEN v_next_kind='done' THEN 'sealed'")
    expect(seal).not.toContain('LOCK TABLE public.posts')
    expect(seal).not.toContain('LOCK TABLE storage.objects')
    const gate = functionBody('read_post_media_coverage_gate_atomic')
    expect(gate).toContain('v_snapshot_inventory_complete')
    expect(gate).toContain('v_snapshot_scope_complete')
    expect(gate).toContain('p_scope IS NULL')
    expect(gate).toContain("'cutover_ready',false")
    expect(gate).toContain("'authoritative_for_gc',false")
    expect(gate).toContain("'requires_new_generation_after_source_drain',true")
    expect(gate).toContain("'observed_at_min',v_observed_at_min")
    expect(gate).toContain("'observed_at_max',v_observed_at_max")
    expect(gate).toContain("'claimable_count',v_claimable_count")
    expect(gate).toContain("'conflicting_count',v_conflicting_count")
    expect(gate).toContain("'quarantined_count',v_quarantined_count")
    expect(gate).not.toContain("'claimable_count',v_run.claimable_count")
    expect(gate).not.toContain("'scope_ready'")
    expect(gate).not.toContain("'latest'")
  })

  it('binds complete canonical evidence and population fingerprints', () => {
    const observe = functionBody('observe_post_media_coverage_inventory_atomic')
    for (const field of [
      'reference_key',
      'source_mask',
      'occurrences',
      'raw_sha256',
      'raw_length',
      'classification',
      'expected_reference_kind',
      'object_name',
      'upload_id',
      'registry_state',
      'storage_state',
      'claim_state',
      'finding',
    ]) {
      expect(observe).toContain(`reference_row.${field}`)
    }
    const seal = functionBody('seal_post_media_coverage_inventory_atomic')
    for (const field of [
      'source_fingerprint',
      'link_fingerprint',
      'eligibility',
      'manifest_fingerprint',
      'reference_count',
      'blockers',
      'observed_at',
    ]) {
      expect(seal).toContain(`v_target.${field}`)
    }
  })

  it('publishes exactly seven fixed-metadata, no-default authorities', () => {
    const names = [
      'install_post_media_coverage_origin_atomic',
      'classify_post_media_reference_lexical_internal',
      'start_post_media_coverage_inventory_atomic',
      'enqueue_post_media_coverage_inventory_atomic',
      'observe_post_media_coverage_inventory_atomic',
      'seal_post_media_coverage_inventory_atomic',
      'read_post_media_coverage_gate_atomic',
    ]
    for (const name of names) {
      const body = functionBody(name)
      expect(body).toContain('SECURITY DEFINER')
      expect(body).toContain('SET search_path = pg_catalog, pg_temp')
      expect(body).toContain('SET row_security = off')
      expect(body).toContain("SET lock_timeout = '5s'")
      expect(body).toContain("SET statement_timeout = '30s'")
      expect(body).toContain("SET TimeZone = 'UTC'")
    }
    expect(migration).toContain('pronargdefaults <> 0')
    expect(migration).toContain('post media coverage reviewed source digest drifted')
    expect(migration.match(/GRANT EXECUTE ON FUNCTION %s TO service_role/g)).toHaveLength(1)
  })

  it('has a real PG17 hostile/replay/runtime/no-mutation matrix', () => {
    for (const marker of [
      'fresh migration',
      'exact replay',
      'origin validation',
      'official direct Storage host',
      'renderer grammar',
      'compressed TOAST array budget',
      'compressed TOAST avatar budget',
      'ownerless retained post quarantine',
      'Unicode whitespace tokenizer parity',
      'oversized reference hash key and bounded status sentinel',
      'zero UUID keyset',
      'attempt provenance',
      'missing-source reinsertion snapshot barrier',
      'snapshot-only gate',
      'scope-local gate counters',
      'cross-TimeZone fingerprint',
      'dependency catalog drift',
      'hostile role graph',
      'source mutation hashes',
      'no claim, GC, release, or Storage mutation',
      '40P01',
      'POST MEDIA COVERAGE PG17: PASS',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
