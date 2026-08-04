import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const authority = readFileSync(
  resolve(root, 'supabase/migrations/20260804054000_copier_snapshot_publication_authority.sql'),
  'utf8'
)
const cutover = readFileSync(
  resolve(root, 'supabase/migrations/20260804055000_copier_snapshot_direct_write_cutover.sql'),
  'utf8'
)
const proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/copier-snapshot-publication-authority.pg17.sh'),
  'utf8'
)
const cutoverProof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/copier-snapshot-direct-write-cutover.pg17.sh'),
  'utf8'
)

function functionBody(sql: string, signature: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const bodyStart = sql.indexOf('AS $function$', start)
  expect(bodyStart).toBeGreaterThan(start)
  const end = sql.indexOf('$function$;', bodyStart + 13)
  expect(end).toBeGreaterThan(bodyStart)
  return sql.slice(bodyStart, end)
}

describe('copier snapshot publication authority', () => {
  const publisher = functionBody(authority, 'public.publish_copier_snapshot_v1')
  const bridgeReader = functionBody(authority, 'public.arena_copier_aggregate')
  const strictReader = functionBody(cutover, 'public.arena_copier_aggregate')

  it('extends the existing private substrate without creating duplicate receipt tables', () => {
    expect(authority).not.toContain('CREATE TABLE arena.copier_snapshot_publications')
    expect(authority).not.toContain('CREATE TABLE arena.copier_snapshot_rows')
    expect(authority).toContain('ADD COLUMN IF NOT EXISTS terminal_verifier_contract text')
    expect(authority).toContain('ADD COLUMN IF NOT EXISTS pnl_distribution jsonb')
    expect(authority).toContain('ADD COLUMN IF NOT EXISTS raw jsonb')
    expect(authority).toContain("'exhausted'")
  })

  it('accepts one exact camelCase request and computes the immutable projection in SQL', () => {
    for (const key of [
      'blockerReasons',
      'contract',
      'currency',
      'evidenceState',
      'observedAt',
      'rawObjectId',
      'rows',
      'scanTerminalState',
      'sourceId',
      'sourceRunId',
      'traderId',
    ]) {
      expect(publisher).toContain(`'${key}'`)
    }
    for (const key of [
      'copierInvested',
      'copierLabel',
      'copierPnl',
      'copyDurationDays',
      'dedupeHash',
      'raw',
      'ts',
    ]) {
      expect(publisher).toContain(`'${key}'`)
    }
    expect(publisher).toContain('jsonb_array_length')
    expect(publisher).toContain("convert_to((p_request->'rows')::text, 'UTF8')")
    expect(publisher).toContain('v_total_copier_pnl')
    expect(publisher).toContain('v_distribution')
    expect(publisher).toContain('GET DIAGNOSTICS v_rows_written = ROW_COUNT')
  })

  it('binds verified exhausted RAW evidence and canonical clocks before publication', () => {
    expect(publisher).toContain("v_raw.job_type IS DISTINCT FROM 'history:copiers'")
    expect(publisher).toContain("v_raw.trust_artifact_role IS DISTINCT FROM 'event_history'")
    expect(publisher).toContain(
      "v_raw.meta->>'terminal_evidence_state' IS DISTINCT FROM 'verified'"
    )
    expect(publisher).toContain("v_raw.meta->>'scan_terminal_state' IS DISTINCT FROM 'exhausted'")
    expect(publisher).toContain("v_raw.meta->>'data_contract' IS DISTINCT FROM")
    expect(publisher).toContain("v_raw.meta->>'history_evidence_contract' IS DISTINCT FROM")
    expect(publisher).toContain("v_raw.meta->>'source_run_id' IS DISTINCT FROM v_source_run_id")
    expect(publisher).toContain("v_raw.meta->>'source_slug' IS DISTINCT FROM v_source_slug")
    expect(publisher).toContain("v_raw.meta->>'exchange_trader_id' IS DISTINCT FROM")
    expect(publisher).toContain("v_raw.meta->'starting_cursor' IS DISTINCT FROM")
    expect(publisher).toContain('\'{"caller_page_cap":null}\'::pg_catalog.jsonb')
    expect(publisher).toContain('v_expected_termination_keys')
    expect(publisher).toContain("v_raw.meta->'termination'->'claim_observations'")
    expect(publisher).toContain('v_page_ordinal > v_page_count')
    expect(publisher).toContain('history-terminal-verifier')
    expect(publisher).toContain("v_raw.meta->'termination'->'blocker_reasons'")
    expect(publisher).toContain('\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\'')
    expect(publisher).toContain("v_row_ts > v_observed_at + interval '5 minutes'")
    expect(authority).toContain('terminal_verifier_contract IS NOT NULL')
    expect(authority).toContain('blocker_reasons IS NOT NULL')
    expect(authority).toContain('request_sha256 IS NOT NULL')
    expect(authority).toContain('copier_count = parsed_row_count')
    expect(authority).toContain('pnl_distribution IS NOT NULL')
  })

  it('returns the exact five-key writer receipt and exact-input replay', () => {
    for (const key of ['receiptId', 'sourceRunId', 'observedAt', 'publishedAt', 'rowCount']) {
      expect(publisher).toContain(`'${key}'`)
    }
    expect(publisher).toContain('arena-copier-source-run:')
    expect(publisher).toContain('v_existing.request_sha256 IS DISTINCT FROM v_request_sha256')
    expect(publisher).toContain('sourceRunId replay conflicts with its immutable request')
    expect(publisher).toContain('A still-live replay continues through the RAW')
    expect(publisher).toContain('AND v_existing.live_raw_object_id IS NULL')
  })

  it('keeps publication private and exposes only aggregate receipt projections', () => {
    expect(authority).toContain('REVOKE ALL ON FUNCTION public.publish_copier_snapshot_v1(jsonb)')
    expect(authority).toContain(
      'GRANT EXECUTE ON FUNCTION public.publish_copier_snapshot_v1(jsonb)'
    )
    expect(authority).toContain('TO service_role')
    for (const body of [bridgeReader, strictReader]) {
      expect(body).toContain("'receiptBound', true")
      expect(body).toContain("'receiptId', receipt.publication_id")
      expect(body).toContain("'sourceRunId', receipt.source_run_id")
      expect(body).toContain('latest_receipt_candidate AS')
      expect(body).toContain('publication.copier_count = publication.parsed_row_count')
      expect(body).toContain('NOT raw_object.quarantined')
      expect(body).toContain('publication.live_raw_object_id IS NULL')
      expect(body).not.toContain('copier_label')
    }
  })

  it('makes legacy fallback temporary and the postdeploy read/write closure irreversible', () => {
    expect(bridgeReader).toContain('copier_aggregate_legacy_containment_v1')
    expect(bridgeReader).toContain('copier_snapshot_legacy_fallback_enabled')
    expect(cutover).toMatch(/copier_snapshot_legacy_fallback_enabled\(\)[\s\S]*?SELECT false;/)
    expect(strictReader).not.toContain('copier_aggregate_legacy_containment_v1')
    expect(strictReader).toContain("resolved.copier_table_depth = 'none'")
    expect(cutover).toContain('CREATE TRIGGER reject_unbound_copier_record_insert')
    expect(cutover).toContain('legacy unbound copier_records inserts are retired')
    expect(cutover).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE')
    expect(cutover).toContain('copier_snapshot_direct_write_cutover_attestation')
    expect(cutover).toContain(
      'RECEIPT_CAPABLE_TIER_C_FULLY_DEPLOYED_LEGACY_DRAINED_COVERAGE_APPROVED'
    )
  })

  it('has isolated PG17 coverage for zero, non-empty, replay, privacy, quarantine and cutover', () => {
    for (const marker of [
      'measured zero aggregate did not mask legacy state',
      'receipt and private rows did not commit atomically',
      'same source run accepted a different request',
      'fractional JSON source id was accepted',
      'non-canonical observation clock was accepted',
      'concurrent exact replay returned different receipts',
      'all-null PnL snapshot was confused with measured zero',
      'late older observation replaced the newer receipt',
      'RAW GC hid the frozen receipt aggregate',
      'RAW GC exact replay changed the frozen receipt',
      'quarantined latest receipt fell back to an older snapshot',
      'quarantined exact replay returned a successful receipt',
      'strict cutover lost explicit depth-none N/A',
      'legacy direct copier insert survived cutover',
      'authority replay reopened legacy fallback after cutover',
      'copier snapshot publication authority 054000 PostgreSQL 17 proof passed',
      'copier snapshot direct-write cutover 055000 PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
    expect(cutoverProof).toContain('COPIER_SNAPSHOT_PROOF_MODE=cutover')
  })

  it('keeps both migrations transactional and ordered', () => {
    expect(authority.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(authority.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(cutover.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(cutover.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(authority.trimEnd()).toMatch(/COMMIT;$/)
    expect(cutover.trimEnd()).toMatch(/COMMIT;$/)
  })
})
