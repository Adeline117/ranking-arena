import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260804054300_copier_snapshot_lane_v2_authority.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/copier-snapshot-lane-v2-authority.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8')
const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
const runbook = readFileSync(resolve(root, 'docs/RUNBOOK.md'), 'utf8')

function functionBody(sql: string, signature: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const bodyStart = sql.indexOf('AS $function$', start)
  expect(bodyStart).toBeGreaterThan(start)
  const end = sql.indexOf('$function$;', bodyStart + 13)
  expect(end).toBeGreaterThan(bodyStart)
  return sql.slice(bodyStart, end)
}

function runnerArray(name: string): string {
  const start = runner.indexOf(`${name}=(`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = runner.indexOf('\n)', start)
  expect(end).toBeGreaterThan(start)
  return runner.slice(start, end)
}

describe('lane-bound copier snapshot V2 authority', () => {
  const publisher = functionBody(migration, 'public.publish_copier_snapshot_v2')
  const reader = functionBody(migration, 'public.arena_copier_aggregate')

  it('is a locked PG17 zero-evidence migration with an exact replay preflight', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain("current_user IS DISTINCT FROM 'postgres'")
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(migration).toContain(
      'LOCK TABLE ONLY arena.copier_snapshot_publications IN ACCESS EXCLUSIVE MODE'
    )
    expect(migration).toContain(
      'LOCK TABLE ONLY arena.copier_snapshot_rows IN ACCESS EXCLUSIVE MODE'
    )
    expect(migration).toContain('requires zero existing receipts and rows')
    expect(migration).toContain('v_raw_binding_count IS DISTINCT FROM 1')
    expect(migration).toContain('v_evidence_binding_count IS DISTINCT FROM 1')
    expect(migration).toContain('v_authority_binding_count IS DISTINCT FROM 0')
    expect(migration).toContain('v_authority_binding_count IS DISTINCT FROM 1')
    expect(migration).toContain('copier lane V2 authority is partially installed')
    expect(migration.match(/AND NOT attribute\.atthasdef/g)?.length).toBeGreaterThanOrEqual(2)
    expect(migration.match(/AND attribute\.attidentity = ''/g)?.length).toBeGreaterThanOrEqual(2)
    expect(migration.match(/AND attribute\.attgenerated = ''/g)?.length).toBeGreaterThanOrEqual(2)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('admits only the copier_snapshot role and exact version-paired receipt projections', () => {
    expect(migration).toMatch(/'copier_audit',\s+'copier_snapshot'/)
    expect(migration).toContain('raw_objects_copier_audit_contract')
    expect(migration).toContain(') IS TRUE\n  );')
    expect(migration).toContain("meta->>'surface' IS NOT DISTINCT FROM 'copiers_audit'")
    expect(migration).toContain(
      "meta->'publication_eligible' IS NOT DISTINCT FROM\n          'false'::pg_catalog.jsonb"
    )
    expect(migration).toContain("'arena.ingest.copier-audit-raw-evidence@1'")
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS acquisition_source_run_id text')
    expect(migration).toContain('copier_snapshot_publication_authority_version')
    expect(migration).toContain("evidence_contract = 'arena.copier-snapshot-publication@1'")
    expect(migration).toContain("publisher_contract = 'arena.ingest.copier-snapshot-publisher@1'")
    expect(migration).toContain('acquisition_source_run_id IS NULL')
    expect(migration).toContain("evidence_contract = 'arena.copier-snapshot-publication@2'")
    expect(migration).toContain("publisher_contract = 'arena.ingest.copier-snapshot-publisher@2'")
    expect(migration).toMatch(
      /data_contract\s*=\s*'arena\.ingest\.copier-publication-lane-artifact@1'/
    )
    expect(migration).toContain("raw_trust_artifact_role_at_publication = 'copier_snapshot'")
    expect(migration).toMatch(
      /raw_evidence_contract_at_publication\s*=\s*'arena\.ingest\.copier-publication-lane-raw-evidence@1'/
    )
  })

  it('publishes an exact 13-key request and seven-key lane-bound receipt', () => {
    for (const requestKey of [
      'acquisitionSourceRunId',
      'blockerReasons',
      'contract',
      'currency',
      'evidenceState',
      'lane',
      'observedAt',
      'rawObjectId',
      'rows',
      'scanTerminalState',
      'sourceId',
      'sourceRunId',
      'traderId',
    ]) {
      expect(publisher).toContain(`'${requestKey}'`)
    }
    expect(publisher).toContain('v_actual_keys IS DISTINCT FROM v_expected_keys')
    expect(publisher).toContain("v_request_lane NOT IN ('tier_b', 'tier_c')")
    expect(publisher).toContain('v_acquisition_source_run_id = v_source_run_id')
    expect(publisher).toContain("WHEN 'tier_b' THEN 'history:copiers'")
    expect(publisher).toContain("WHEN 'tier_c' THEN 'tier_c'")
    for (const receiptKey of [
      'receiptId',
      'sourceRunId',
      'acquisitionSourceRunId',
      'lane',
      'observedAt',
      'publishedAt',
      'rowCount',
    ]) {
      expect(publisher).toContain(`'${receiptKey}'`)
    }
    expect(publisher).not.toContain('public.publish_copier_snapshot_v1')
    expect(publisher).not.toContain('current_setting')
  })

  it('binds exact RAW metadata, terminal proof, integrity, subject, and database clocks', () => {
    expect(publisher).toContain('v_actual_keys IS DISTINCT FROM v_expected_meta_keys')
    expect(publisher).toContain("v_raw.trust_artifact_role IS DISTINCT FROM 'copier_snapshot'")
    expect(publisher).toContain('RAW role is audit-only or otherwise not publication eligible')
    expect(publisher).toContain('v_raw.content_hash IS DISTINCT FROM v_source_run_id')
    expect(publisher).toContain('v_raw.fetched_at IS DISTINCT FROM v_observed_at')
    expect(publisher).toContain("v_raw.meta->'starting_cursor' IS DISTINCT FROM 'null'::jsonb")
    expect(publisher).toContain('\'{"caller_page_cap":null}\'::jsonb')
    expect(publisher).toContain('v_actual_keys IS DISTINCT FROM v_expected_termination_keys')
    expect(publisher).toContain("'empty_page'")
    expect(publisher).toContain("'snapshot_complete'")
    expect(publisher).toContain('v_page_ordinal > v_page_count')
    expect(publisher).toContain('v_actual_keys IS DISTINCT FROM v_expected_integrity_keys')
    expect(publisher).toContain("'arena.strict-canonical-json@1'")
    expect(publisher).toContain('v_compressed_bytes IS DISTINCT FROM v_raw.bytes')
    expect(publisher).toContain("source_row.status = 'active'")
    expect(publisher).toContain("source_row.serving_mode = 'serving'")
    expect(publisher).toContain('FOR SHARE OF source_row, trader_row')
    expect(publisher).toContain("v_trader_meta->>'claimed' = 'true'")
    expect(publisher).toContain(
      "v_observed_at >\n        pg_catalog.statement_timestamp() + interval '5 minutes'"
    )
  })

  it('serializes exact replay and writes rows plus receipt in one authority transaction', () => {
    expect(publisher).toContain("'arena-copier-source-run:' || v_source_run_id")
    expect(publisher).toContain("'arena-copier-subject:' ||")
    expect(publisher).toContain('replay conflicts with its immutable request')
    expect(publisher).toContain('v_existing.live_raw_object_id IS NULL')
    expect(publisher).toContain('INSERT INTO arena.copier_snapshot_publications')
    expect(publisher).toContain('INSERT INTO arena.copier_snapshot_rows')
    expect(publisher).toContain('GET DIAGNOSTICS v_rows_written = ROW_COUNT')
    expect(publisher).toContain('v_rows_written IS DISTINCT FROM v_row_count')
  })

  it('keeps the rolling V1 reader while serving exact V1 and V2 receipts through @3', () => {
    expect(reader).toContain('arena.copier-snapshot-receipt-reader@3')
    expect(reader).toContain("'arena.copier-snapshot-publication@1'")
    expect(reader).toContain("'arena.copier-snapshot-publication@2'")
    expect(reader).toContain("publication.lane = 'tier_c'")
    expect(reader).toContain("publication.lane IN ('tier_b', 'tier_c')")
    expect(reader).toContain('publication.acquisition_source_run_id')
    expect(reader).toContain('arena.copier_snapshot_legacy_fallback_enabled()')
    expect(migration).toContain("'service_role', v_v1, 'EXECUTE'")
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.publish_copier_snapshot_v2(jsonb)'
    )
  })

  it('proves catalog, subject, RAW, terminal, integrity, replay, privacy, and races on PG17', () => {
    for (const marker of [
      'raw-binding-preflight-drift',
      'raw-target-without-v2-preflight-drift',
      'reader-v3-without-v2-preflight-drift',
      'publication-constraint-preflight-drift',
      'partial-column-preflight-drift',
      'audit-contract-preflight-drift',
      'lane-aware-constraint-replay-drift',
      'audit-contract-replay-drift',
      'reader-v1-with-v2-replay-drift',
      'copier audit RAW frozen shape',
      'copier-audit-role-without-source-run',
      'eligible-copier-audit-raw',
      'missing-copier-audit-meta',
      'empty-copier-audit-meta',
      'missing-copier-audit-publication-eligible',
      'missing-copier-audit-evidence-contract',
      'missing-copier-audit-data-contract',
      'null-copier-audit-surface',
      'null-copier-audit-publication-eligible',
      'null-copier-audit-evidence-contract',
      'null-copier-audit-data-contract',
      'wrong-copier-audit-contract',
      'v1-cannot-consume-copier-audit',
      'v2-cannot-consume-copier-audit',
      'null-v2-publication-authority-coordinate',
      'inactive-subject',
      'shadow-subject',
      'unsupported-depth-subject',
      'cross-source-trader-subject',
      'quarantined-raw',
      'null-quarantine-state',
      'wrong-meta-subject',
      'extra-meta-key',
      'missing-terminal-claims',
      'null-top-level-terminal-verifier',
      'extra-terminal-observation-key',
      'terminal-page-outside-capture',
      'extra-raw-integrity-key',
      'raw-integrity-byte-drift',
      'tombstone-conflicting-replay',
      'lane claim-first publication did not wait for the claim lock',
      'lane publication-first claim did not wait for the publication lock',
      'concurrent exact replay receipts diverged',
      'copier snapshot lane V2 PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })

  it('is wired 0540→0542→0543→0545 while obsolete 055 remains HOLD', () => {
    const authority = '20260804054000_copier_snapshot_publication_authority.sql'
    const provenance = '20260804054200_harden_copier_snapshot_receipt_provenance.sql'
    const correction = '20260804054500_correct_okx_copier_depth_contract.sql'
    const cutover = '20260804055000_copier_snapshot_direct_write_cutover.sql'
    const predeploy = runnerArray('PREDEPLOY_MIGRATIONS')

    expect(predeploy).toContain(
      `${authority}\n  ${provenance}\n  ${migrationName}\n  ${correction}`
    )
    for (const phase of [
      'PREDEPLOY_MIGRATIONS',
      'POSTDEPLOY_MIGRATIONS',
      'RECOVERY_PREREQUISITE_MIGRATIONS',
      'CONCURRENT_RECOVERY_MIGRATIONS',
      'RECOVERY_MIGRATIONS',
      'QUARANTINED_PREDEPLOY_MIGRATIONS',
      'SUPERSEDED_MIGRATIONS',
    ]) {
      expect(runnerArray(phase)).not.toContain(cutover)
    }
    expect(runner).toContain('no standard runner phase and is HOLD / DO NOT APPLY')
    expect(packageJson).toContain('qa:copier-snapshot-lane-v2-pg17')
    expect(ci).toContain('npm run qa:copier-snapshot-lane-v2-pg17')
    expect(runbook).toContain(migrationName)
    expect(runbook).toContain('040550`：**HOLD**')
  })
})
