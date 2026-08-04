import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260803101000_verified_position_history_publication_writer.sql'
  ),
  'utf8'
)

const withoutComments = (value: string): string =>
  value.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const functionDefinition = (name: string): string => {
  const escapedName = name.replace(/\./g, '\\.')
  const start = new RegExp(`CREATE FUNCTION\\s+${escapedName}\\s*\\(`, 'i').exec(migration)?.index
  if (start === undefined) return ''

  const remainder = migration.slice(start)
  const opening = /\bAS\s+\$([a-zA-Z0-9_]*)\$/i.exec(remainder)
  if (!opening) return ''

  const delimiter = `$${opening[1]}$`
  const bodyStart = (opening.index ?? 0) + opening[0].length
  const bodyEnd = remainder.indexOf(delimiter, bodyStart)
  if (bodyEnd < 0) return ''

  return remainder.slice(0, bodyEnd + delimiter.length + 1)
}

const functionBody = (name: string): string => {
  const definition = functionDefinition(name)
  const opening = /\bAS\s+\$([a-zA-Z0-9_]*)\$/i.exec(definition)
  if (!opening) return ''

  const delimiter = `$${opening[1]}$`
  const bodyStart = (opening.index ?? 0) + opening[0].length
  return definition.slice(bodyStart, definition.lastIndexOf(delimiter))
}

const signature = (name: string): string[] => {
  const escapedName = name.replace(/\./g, '\\.')
  const argumentsSql = migration.match(
    new RegExp(`CREATE FUNCTION\\s+${escapedName}\\s*\\(([\\s\\S]*?)\\)\\s*RETURNS`, 'i')
  )?.[1]

  return (argumentsSql ?? '')
    .split(',')
    .map((argument) => argument.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

const checkpointName = 'arena.get_position_history_publication_checkpoint'
const chainGuardName = 'arena.position_history_publication_chain_healthy'
const rowGuardName = 'arena.protect_verified_position_history_row'
const writerName = 'arena.publish_verified_position_history'
const checkpointDefinition = functionDefinition(checkpointName)
const chainGuardDefinition = functionDefinition(chainGuardName)
const rowGuardDefinition = functionDefinition(rowGuardName)
const rowGuard = functionBody(rowGuardName)
const writerDefinition = functionDefinition(writerName)
const checkpoint = functionBody(checkpointName)
const chainGuard = functionBody(chainGuardName)
const writer = functionBody(writerName)
const sql = withoutComments(migration)

describe('verified position-history publication writer migration', () => {
  it('installs only the exact hardened checkpoint and writer RPC signatures', () => {
    expect(signature(checkpointName)).toEqual(['p_source_id smallint', 'p_trader_id bigint'])
    expect(signature(chainGuardName)).toEqual([
      'p_root_publication_id bigint',
      'p_source_id smallint',
      'p_trader_id bigint',
    ])
    expect(signature(writerName)).toEqual([
      'p_raw_object_id bigint',
      'p_previous_publication_id bigint',
      'p_effective_cursor_after timestamptz',
      'p_rows jsonb',
      'p_lane text',
      'p_publisher_contract text',
    ])

    expect(checkpointDefinition).toMatch(
      /RETURNS jsonb\s+LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER/
    )
    expect(checkpointDefinition).toContain('SET search_path = pg_catalog, pg_temp')
    expect(checkpointDefinition).toContain("SET statement_timeout = '10s'")
    expect(checkpointDefinition).toContain("SET TimeZone = 'UTC'")
    expect(writerDefinition).toMatch(
      /RETURNS jsonb\s+LANGUAGE plpgsql\s+VOLATILE\s+SECURITY DEFINER/
    )
    expect(writerDefinition).toContain('SET search_path = pg_catalog, pg_temp')
    expect(writerDefinition).toContain("SET lock_timeout = '10s'")
    expect(writerDefinition).toContain("SET statement_timeout = '2min'")
    expect(writerDefinition).toContain("SET TimeZone = 'UTC'")

    expect(signature(rowGuardName)).toEqual([])
    expect(chainGuardDefinition).toMatch(/RETURNS boolean\s+LANGUAGE sql\s+STABLE/)
    expect(chainGuardDefinition).not.toContain('SECURITY DEFINER')
    expect(chainGuardDefinition).toContain('SET search_path = pg_catalog, pg_temp')
    expect(chainGuardDefinition).toContain("SET TimeZone = 'UTC'")
    expect(
      [...migration.matchAll(/CREATE FUNCTION\s+([a-z0-9_.]+)\s*\(/gi)].map((match) => match[1])
    ).toEqual([chainGuardName, checkpointName, rowGuardName, writerName])
    expect(migration.match(/SECURITY DEFINER/gi)).toHaveLength(2)
    expect(migration).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION\s+public\./i)
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION/i)
  })

  it('keeps both RPCs service-only and proves their owner and metadata after grants', () => {
    for (const name of [checkpointName, writerName]) {
      const escapedName = name.replace(/\./g, '\\.')
      expect(migration).toMatch(
        new RegExp(`ALTER FUNCTION\\s+${escapedName}\\([\\s\\S]*?OWNER TO postgres;`, 'i')
      )
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION\\s+${escapedName}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role;`,
          'i'
        )
      )
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION\\s+${escapedName}\\([\\s\\S]*?TO service_role;`, 'i')
      )
    }

    expect(migration.match(/GRANT EXECUTE ON FUNCTION/gi)).toHaveLength(2)
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION arena\.position_history_publication_chain_healthy\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.position_history_publication_chain_healthy\(/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION arena\.protect_verified_position_history_row\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.protect_verified_position_history_row\(\)/
    )
    expect(migration).not.toMatch(
      /GRANT\s+(?:ALL|EXECUTE)[\s\S]*?TO\s+(?:PUBLIC|anon|authenticated)/i
    )
    expect(migration).toContain("expanded.privilege_type = 'EXECUTE'")
    expect(migration).toContain("expanded.grantee <> 'service_role'::pg_catalog.regrole")
    expect(migration).toContain('v_chain_guard')
    expect(migration).toContain("function_row.proowner <> 'postgres'::pg_catalog.regrole")
    expect(migration).toContain('OR NOT function_row.prosecdef')
    expect(migration).toContain('OR function_row.proleakproof')
    expect(migration).toContain('OR function_row.proretset')
    expect(migration).toContain("function_row.prorettype <> 'pg_catalog.jsonb'::pg_catalog.regtype")
    expect(migration).toContain("'search_path=pg_catalog, pg_temp'")
    expect(migration).toContain("'TimeZone=UTC'")
    expect(migration).toContain(
      'verified position-history writer ACL or metadata postflight failed'
    )
  })

  it('derives the checkpoint only from the latest authoritative receipt', () => {
    expect(checkpoint).toContain('FROM arena.record_surface_publications AS publication')
    expect(checkpoint).toContain("publication.surface = 'position_history'")
    expect(checkpoint).toContain(
      'ORDER BY publication.observed_at DESC, publication.publication_id DESC'
    )
    expect(checkpoint).toContain("'publicationId', NULL::bigint")
    expect(checkpoint).toContain("'cursor', NULL::timestamptz")
    expect(checkpoint).toContain("'observedAt', NULL::timestamptz")
    expect(checkpoint).toContain("'cursor', v_publication.effective_cursor_after")
    expect(checkpoint).toContain('arena.position_history_publication_chain_healthy(')
    expect(checkpoint).toContain('v_publication.publication_id')
    expect(checkpoint).toContain('or its chain is invalid')
    expect(checkpoint).toContain("USING ERRCODE = '55000'")
    expect(checkpoint).not.toContain('arena.ingest_cursors')
    expect(migration).toContain('Never derives trust from legacy ingest_cursors.')
  })

  it('locks and validates the exact immutable RAW identity before trusting metadata', () => {
    const identityRead = writer.indexOf('SELECT raw_object.source_id, raw_object.trader_id')
    const advisoryLock = writer.indexOf('pg_catalog.pg_advisory_xact_lock(', identityRead)
    const rawReload = writer.indexOf('SELECT raw_object.*', advisoryLock)
    const rawRowLock = writer.indexOf('FOR UPDATE', rawReload)
    const metadataValidation = writer.indexOf("v_raw.meta->>'surface'", advisoryLock)

    expect(identityRead).toBeGreaterThan(-1)
    expect(advisoryLock).toBeGreaterThan(identityRead)
    expect(rawReload).toBeGreaterThan(-1)
    expect(rawRowLock).toBeGreaterThan(rawReload)
    expect(metadataValidation).toBeGreaterThan(advisoryLock)
    expect(writer).toContain('v_raw.source_id IS DISTINCT FROM v_raw_identity_source_id')
    expect(writer).toContain('v_raw.trader_id IS DISTINCT FROM v_raw_identity_trader_id')
    expect(writer).toContain('RAW identity changed during publication')

    for (const token of [
      'v_raw.quarantined IS DISTINCT FROM false',
      "v_raw.job_type IS DISTINCT FROM 'history:position_history'",
      'v_raw.timeframe IS NOT NULL',
      "v_raw.trust_artifact_role IS DISTINCT FROM 'event_history'",
      "v_raw.source_run_id !~ '^[0-9a-f]{64}$'",
      "v_raw.source_run_id = pg_catalog.repeat('0', 64)",
      'v_raw.content_hash IS DISTINCT FROM v_raw.source_run_id',
      'v_raw.bytes <= 0',
      'NOT pg_catalog.isfinite(v_raw.fetched_at)',
      "v_raw.fetched_at > pg_catalog.statement_timestamp() + interval '5 minutes'",
      "pg_catalog.jsonb_typeof(v_raw.meta) IS DISTINCT FROM 'object'",
      'v_trader.source_id IS DISTINCT FROM v_source.id',
      'FOR SHARE',
      'source or trader identity changed during publication',
    ]) {
      expect(writer).toContain(token)
    }
  })

  it('binds the complete verified acquisition and RAW-integrity metadata contract', () => {
    for (const token of [
      "v_raw.meta->>'surface' IS DISTINCT FROM 'position_history'",
      "v_raw.meta->>'history_kind' IS DISTINCT FROM 'position_history'",
      "'arena.ingest.history-acquisition-artifact@1'",
      "'arena.position-history-publication-evidence@1'",
      "v_raw.meta->>'source_run_id' IS DISTINCT FROM v_raw.source_run_id",
      "v_raw.meta->>'source_slug' IS DISTINCT FROM v_source.slug",
      "v_raw.meta->>'exchange_trader_id' IS DISTINCT FROM",
      "v_raw.meta->>'terminal_evidence_state' IS DISTINCT FROM 'verified'",
      "v_raw.meta->'capture_config' IS DISTINCT FROM",
      `'{"caller_page_cap":null}'::jsonb`,
      'FROM pg_catalog.jsonb_object_keys(v_raw.meta) AS member(key)',
      "'raw_integrity'",
      "v_raw.meta->'starting_cursor' IS NULL",
      "pg_catalog.jsonb_typeof(v_raw.meta->'observed_at') IS DISTINCT FROM 'string'",
      "pg_catalog.jsonb_typeof(v_raw.meta->'attempt_started_at') IS DISTINCT FROM 'string'",
      "v_raw.meta->>'observed_at' !~ v_canonical_timestamp_pattern",
      "v_raw.meta->>'attempt_started_at' !~ v_canonical_timestamp_pattern",
      "pg_catalog.jsonb_typeof(v_raw.meta->'page_count') IS DISTINCT FROM 'number'",
      "pg_catalog.jsonb_typeof(v_raw.meta->'termination') IS DISTINCT FROM 'object'",
      "pg_catalog.jsonb_typeof(v_raw.meta->'raw_integrity') IS DISTINCT FROM 'object'",
      "'arena.strict-canonical-json@1'",
      "'sha256'",
      "'json_utf8'",
      "'gzip'",
      "'utf-8'",
      "'application/json'",
      "v_raw.meta->'raw_integrity'->'version'",
      "v_raw.meta->'raw_integrity'->'version' IS DISTINCT FROM '1'::jsonb",
      "v_raw.meta->'raw_integrity'->'compressed_bytes'",
      'pg_catalog.to_jsonb(v_raw.bytes)',
      "v_raw.meta->'raw_integrity'->'uncompressed_bytes'",
      "(v_raw.meta->'raw_integrity'->>'uncompressed_bytes')::numeric <= 0",
      'pg_catalog.trunc(',
    ]) {
      expect(writer).toContain(token)
    }
    expect(writer).toContain("'compressed_bytes', 'uncompressed_bytes'")
    expect(writer).toContain('verified position-history RAW evidence binding is invalid')
    expect(writer).not.toContain('arena.ingest.history-acquisition-artifact@2')
    expect(writer).not.toContain('candidate_ledger_contract')
    expect(writer).not.toContain('source_fact_contract')
  })

  it('accepts only complete terminal evidence with ordered unique bounded claims', () => {
    for (const token of [
      'v_observed_at IS DISTINCT FROM v_raw.fetched_at',
      'v_attempt_started_at > v_observed_at',
      'v_page_count <= 0',
      'v_page_count > 100000',
      "v_raw.meta->>'scan_terminal_state' IS DISTINCT FROM v_scan_terminal_state",
      "v_raw.meta->>'verifier_contract' IS DISTINCT FROM v_verifier_contract",
      "v_termination->>'evidence_state' IS DISTINCT FROM 'verified'",
      "v_termination->'blocker_reasons' IS DISTINCT FROM '[]'::jsonb",
      'FROM pg_catalog.jsonb_object_keys(v_termination) AS member(key)',
      "v_scan_terminal_state NOT IN ('exhausted', 'cursor_overlap')",
      '^arena\\.ingest\\.history-terminal-verifier\\.',
      'pg_catalog.jsonb_array_length(v_claim_observations) NOT BETWEEN 1 AND 8',
      "claim.value->>'segment_id' !~ '^[a-z0-9][a-z0-9_]{0,63}$'",
      'FROM pg_catalog.jsonb_object_keys(claim.value) AS member(key)',
      "'segment_id', 'reason', 'page_ordinal'",
      "'empty_page', 'short_page', 'reported_end'",
      "'cursor_overlap', 'snapshot_complete'",
      "(claim.value->>'page_ordinal')::numeric < 1",
      "(claim.value->>'page_ordinal')::numeric > v_page_count",
      'pg_catalog.trunc',
      "GROUP BY claim.value->>'segment_id'",
      'grouped.copies <> 1',
      'WITH ORDINALITY AS claim(value, ordinal)',
      'ordered_claim.page_ordinal <= ordered_claim.previous_page_ordinal',
    ]) {
      expect(writer).toContain(token)
    }

    expect(writer).toContain('verified position-history terminal evidence is invalid')
    expect(writer).not.toMatch(/terminal_evidence_state[^\n]*'(?:partial|unknown|tier_c)'/i)
  })

  it('binds exhaustion and overlap evidence to the starting cursor and parsed rows', () => {
    expect(writer).toContain("IF v_raw.meta->'starting_cursor' = 'null'::jsonb THEN")
    expect(writer).toContain(
      "ELSIF pg_catalog.jsonb_typeof(v_raw.meta->'starting_cursor') = 'string' THEN"
    )
    expect(writer).toContain('NOT pg_catalog.isfinite(v_starting_cursor)')
    expect(writer).toContain("v_raw.meta->>'starting_cursor' !~ v_canonical_timestamp_pattern")

    const overlap = writer.slice(
      writer.indexOf("IF v_scan_terminal_state = 'cursor_overlap' THEN"),
      writer.indexOf('IF EXISTS (\n    SELECT 1\n    FROM pg_catalog.jsonb_array_elements(p_rows)')
    )
    expect(overlap).toContain('v_starting_cursor IS NULL')
    expect(overlap).toContain("v_termination->'terminal_cursor_value'")
    expect(overlap).toContain("v_termination->'overlap_event_at'")
    expect(overlap).toContain('v_terminal_cursor IS DISTINCT FROM v_starting_cursor')
    expect(overlap).toContain('v_overlap_event_at > v_starting_cursor')
    expect(overlap).toContain(
      "v_termination->>'terminal_cursor_value' !~\n         v_canonical_timestamp_pattern"
    )
    expect(overlap).toContain("claim.value->>'reason' = 'cursor_overlap'")
    expect(overlap).toContain(
      "v_termination->'terminal_cursor_value' IS DISTINCT FROM 'null'::jsonb"
    )
    expect(overlap).toContain("v_termination->'overlap_event_at' IS DISTINCT FROM 'null'::jsonb")
    expect(overlap).toContain('verified exhaustion evidence cannot depend on a cursor')

    expect(writer).toContain('WHEN v_starting_cursor IS NULL THEN v_newest_event_at')
    expect(writer).toContain('WHEN v_newest_event_at IS NULL THEN v_starting_cursor')
    expect(writer).toContain('GREATEST(v_starting_cursor, v_newest_event_at)')
    expect(writer).toContain('p_effective_cursor_after IS DISTINCT FROM v_expected_cursor_after')
    expect(writer).toContain('row_value.closed_at::timestamptz = v_overlap_event_at')
  })

  it('validates every receipt and retained RAW pointer in the predecessor lineage', () => {
    for (const token of [
      'WITH RECURSIVE publication_chain AS',
      'publication_chain.visited || predecessor.publication_id',
      'predecessor.publication_id = ANY(publication_chain.visited)',
      'publication_chain.observed_at > predecessor.observed_at',
      "publication_chain.surface = 'position_history'",
      'publication_chain.source_id = p_source_id',
      'publication_chain.trader_id = p_trader_id',
      'publication_chain.valid_successor_link',
      'raw_object.quarantined = false',
      'raw_object.source_run_id = publication_chain.source_run_id',
      'raw_object.storage_path = publication_chain.raw_storage_path',
      'raw_object.content_hash = publication_chain.raw_content_hash',
      'raw_object.fetched_at = publication_chain.raw_fetched_at',
    ]) {
      expect(chainGuard).toContain(token)
    }

    expect(checkpoint).toContain('arena.position_history_publication_chain_healthy(')
    expect(writer.match(/arena\.position_history_publication_chain_healthy\(/g)).toHaveLength(2)
    expect(writer).toContain('replayed position-history publication evidence is unavailable')
    expect(writer).toContain('latest position-history publication evidence is unavailable')
    expect(writer).toContain('FOR UPDATE OF raw_object')
  })

  it('supports zero-row genesis while enforcing authoritative head continuity and stale rejection', () => {
    expect(writer).not.toMatch(/jsonb_array_length\(p_rows\)\s*(?:=|<=|<)\s*0/)
    expect(writer).toContain('v_parsed_row_count := pg_catalog.jsonb_array_length(p_rows)')
    expect(writer).toContain('SELECT pg_catalog.max(row_value.closed_at::timestamptz)')
    expect(writer).toContain('SELECT pg_catalog.count(*)::integer')
    expect(writer).toContain('INTO STRICT v_bound_count')

    const headLookup = writer.indexOf('INTO v_head')
    const receiptInsert = writer.indexOf(
      'INSERT INTO arena.record_surface_publications',
      headLookup
    )
    const headRules = writer.slice(headLookup, receiptInsert)
    expect(headRules).toContain(
      'ORDER BY publication.observed_at DESC, publication.publication_id DESC'
    )
    expect(headRules).toContain('p_previous_publication_id IS DISTINCT FROM v_head.publication_id')
    expect(headRules).toContain('v_observed_at <= v_head.observed_at')
    expect(headRules).toContain("USING ERRCODE = '40001'")
    expect(headRules).toContain('v_head.effective_cursor_after IS NULL')
    expect(headRules).toContain("v_scan_terminal_state IS DISTINCT FROM 'exhausted'")
    expect(headRules).toContain('v_starting_cursor IS DISTINCT FROM v_head.effective_cursor_after')
    expect(headRules).toContain("v_scan_terminal_state IS DISTINCT FROM 'cursor_overlap'")
    expect(headRules).toContain('p_previous_publication_id IS NOT NULL')
    expect(headRules).toContain(
      'first position-history publication requires a cursorless exhaustive capture'
    )
  })

  it('freezes exact replay before head checks and every publication mutation', () => {
    const replayLookup = writer.indexOf('INTO v_existing')
    const replayConflict = writer.indexOf(
      'verified position-history replay conflicts with its frozen receipt',
      replayLookup
    )
    const replayReturn = writer.indexOf("'replayed', true", replayConflict)
    const headLookup = writer.indexOf('INTO v_head', replayReturn)
    const receiptInsert = writer.indexOf(
      'INSERT INTO arena.record_surface_publications',
      headLookup
    )
    const typedUpsert = writer.indexOf('INSERT INTO arena.position_history', receiptInsert)
    const cursorDelete = writer.indexOf('DELETE FROM arena.ingest_cursors', typedUpsert)

    expect(replayLookup).toBeGreaterThan(-1)
    expect(replayConflict).toBeGreaterThan(replayLookup)
    expect(replayReturn).toBeGreaterThan(replayConflict)
    expect(headLookup).toBeGreaterThan(replayReturn)
    expect(receiptInsert).toBeGreaterThan(headLookup)
    expect(typedUpsert).toBeGreaterThan(receiptInsert)
    expect(cursorDelete).toBeGreaterThan(typedUpsert)

    const replayPath = writer.slice(replayLookup, replayReturn)
    for (const token of [
      'publication.source_run_id = v_raw.source_run_id',
      'v_existing.lane IS DISTINCT FROM p_lane',
      'v_existing.previous_publication_id IS DISTINCT FROM',
      'v_existing.raw_object_id IS NOT NULL',
      'v_existing.raw_storage_path IS DISTINCT FROM v_raw.storage_path',
      'v_existing.raw_content_hash IS DISTINCT FROM v_raw.content_hash',
      'v_existing.raw_fetched_at IS DISTINCT FROM v_raw.fetched_at',
      'v_existing.observed_at IS DISTINCT FROM v_observed_at',
      'v_existing.publisher_contract IS DISTINCT FROM p_publisher_contract',
      'v_existing.scan_terminal_state IS DISTINCT FROM v_scan_terminal_state',
      'v_existing.starting_cursor IS DISTINCT FROM v_starting_cursor',
      'v_existing.effective_cursor_after IS DISTINCT FROM',
      'v_existing.overlap_event_at IS DISTINCT FROM v_overlap_event_at',
      'v_existing.page_count IS DISTINCT FROM v_page_count',
      'v_existing.parsed_row_count IS DISTINCT FROM v_parsed_row_count',
      'v_existing.row_set_sha256 IS DISTINCT FROM v_row_set_sha256',
      'v_existing.termination IS DISTINCT FROM v_termination',
      "USING ERRCODE = '23505'",
      "'rowsWritten', 0",
    ]) {
      expect(replayPath).toContain(token)
    }
    expect(replayPath).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/)
  })

  it('rejects non-canonical rows, duplicate typed keys, and caller-chosen cursors', () => {
    const rowEnvelope = writer.slice(
      writer.indexOf('FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)')
    )
    const allowedKeys = rowEnvelope.match(
      /member\.key <> ALL \(ARRAY\[([\s\S]*?)\]::text\[\]\)/
    )?.[1]
    expect(allowedKeys?.match(/'[a-z_]+'/g)).toEqual([
      "'opened_at'",
      "'closed_at'",
      "'symbol'",
      "'side'",
      "'leverage'",
      "'size'",
      "'entry_price'",
      "'exit_price'",
      "'realized_pnl'",
      "'dedupe_hash'",
      "'raw'",
    ])

    for (const token of [
      "pg_catalog.jsonb_typeof(item.value) IS DISTINCT FROM 'object'",
      "pg_catalog.jsonb_typeof(item.value->'closed_at') IS DISTINCT FROM 'string'",
      "pg_catalog.jsonb_typeof(item.value->'symbol') IS DISTINCT FROM 'string'",
      "pg_catalog.jsonb_typeof(item.value->'dedupe_hash') IS DISTINCT FROM 'string'",
      "pg_catalog.jsonb_typeof(item.value->'raw') IS DISTINCT FROM 'object'",
      "'leverage', 'size', 'entry_price', 'exit_price', 'realized_pnl'",
      'NOT pg_catalog.isfinite(row_value.closed_at::timestamptz)',
      'row_value.closed_at !~ v_canonical_timestamp_pattern',
      "row_value.closed_at::timestamptz > v_observed_at + interval '5 minutes'",
      'row_value.opened_at::timestamptz > row_value.closed_at::timestamptz',
      'row_value.opened_at !~ v_canonical_timestamp_pattern',
      'row_value.symbol <> pg_catalog.btrim(row_value.symbol)',
      'pg_catalog.char_length(row_value.symbol) NOT BETWEEN 1 AND 128',
      'pg_catalog.char_length(row_value.side) NOT BETWEEN 1 AND 32',
      'pg_catalog.char_length(row_value.dedupe_hash) NOT BETWEEN 1 AND 512',
      'GROUP BY row_value.closed_at::timestamptz, row_value.dedupe_hash',
      'HAVING pg_catalog.count(*) <> 1',
      "pg_catalog.sha256(pg_catalog.convert_to(p_rows::text, 'UTF8'))",
    ]) {
      expect(writer).toContain(token)
    }
  })

  it('upserts only exact existing typed rows and binds every row to its receipt', () => {
    const insertColumns = writer.match(
      /INSERT INTO arena\.position_history\s*\(([\s\S]*?)\)\s*SELECT/
    )?.[1]
    expect(
      (insertColumns ?? '')
        .split(',')
        .map((column) => column.trim())
        .filter(Boolean)
    ).toEqual([
      'trader_id',
      'opened_at',
      'closed_at',
      'symbol',
      'side',
      'leverage',
      'size',
      'entry_price',
      'exit_price',
      'realized_pnl',
      'currency',
      'dedupe_hash',
      'raw',
      'verified_publication_id',
    ])

    const conflict = writer.match(
      /ON CONFLICT \(closed_at, dedupe_hash\) DO UPDATE SET([\s\S]*?)\n\s*RETURNING 1/
    )?.[1]
    expect(conflict).toBeDefined()
    expect(conflict?.match(/^[ \t]+[a-z_]+\s*=/gm)).toEqual(['      verified_publication_id ='])
    expect(conflict).toContain('verified_publication_id = EXCLUDED.verified_publication_id')
    expect(conflict).toContain('arena.position_history.trader_id = EXCLUDED.trader_id')
    for (const column of [
      'opened_at',
      'symbol',
      'side',
      'leverage',
      'size',
      'entry_price',
      'exit_price',
      'realized_pnl',
      'currency',
      'raw',
    ]) {
      expect(conflict).toContain(
        `arena.position_history.${column} IS NOT DISTINCT FROM EXCLUDED.${column}`
      )
    }

    expect(writer).toContain('v_publication_id\n    FROM pg_catalog.jsonb_to_recordset(p_rows)')
    expect(writer).toContain('v_bound_count IS DISTINCT FROM v_parsed_row_count')
    expect(writer).toContain('verified position-history rows conflict with existing typed data')
    expect(writer).toMatch(
      /verified position-history rows conflict with existing typed data'[\s\S]*?ERRCODE = '23505'/
    )
  })

  it('makes verified typed-row bindings writer-owned and immutable after publication', () => {
    expect(rowGuardDefinition).toMatch(/RETURNS trigger\s+LANGUAGE plpgsql/)
    expect(rowGuardDefinition).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('BEFORE INSERT OR UPDATE OR DELETE ON arena.position_history')
    expect(migration).toContain('BEFORE TRUNCATE ON arena.position_history')
    expect(
      migration.match(/EXECUTE FUNCTION arena\.protect_verified_position_history_row\(\)/g)
    ).toHaveLength(2)
    expect(rowGuard).toContain("IF TG_OP = 'TRUNCATE' THEN")
    expect(rowGuard).toContain("IF TG_OP = 'DELETE' THEN")
    expect(rowGuard).toContain('OLD.verified_publication_id IS NOT NULL')
    expect(rowGuard).toContain("pg_catalog.to_jsonb(NEW) - 'verified_publication_id'")
    expect(rowGuard).toContain("pg_catalog.to_jsonb(OLD) - 'verified_publication_id'")
    expect(rowGuard).toContain('NEW.verified_publication_id IS NULL')
    expect(rowGuard).toContain("CURRENT_USER <> 'postgres'")
    expect(rowGuard).toContain("v_authorized_publication !~ '^[1-9][0-9]*$'")
    expect(rowGuard).toContain(
      'v_authorized_publication::bigint IS DISTINCT FROM\n          NEW.verified_publication_id'
    )
    expect(rowGuard).toContain('verified position-history binding is writer-owned')

    const receiptInsert = writer.indexOf('INSERT INTO arena.record_surface_publications')
    const authorizationSet = writer.indexOf(
      "'arena.verified_position_history_publication_id'",
      receiptInsert
    )
    const typedUpsert = writer.indexOf('INSERT INTO arena.position_history', authorizationSet)
    const authorizationClear = writer.indexOf(
      "'arena.verified_position_history_publication_id'",
      typedUpsert
    )
    const exactCountGate = writer.indexOf(
      'v_bound_count IS DISTINCT FROM v_parsed_row_count',
      authorizationClear
    )
    expect(authorizationSet).toBeGreaterThan(receiptInsert)
    expect(typedUpsert).toBeGreaterThan(authorizationSet)
    expect(authorizationClear).toBeGreaterThan(typedUpsert)
    expect(exactCountGate).toBeGreaterThan(authorizationClear)
  })

  it('removes service-role TRUNCATE from the parent, current children, and future defaults', () => {
    expect(migration).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena\n  REVOKE TRUNCATE ON TABLES FROM service_role'
    )
    expect(migration).toContain(
      'REVOKE TRUNCATE ON TABLE arena.position_history\n  FROM PUBLIC, anon, authenticated, service_role'
    )
    expect(migration).toContain('DO $lock_down_position_history_truncate$')
    expect(migration).toContain(
      "'REVOKE TRUNCATE ON TABLE %s FROM PUBLIC, anon, authenticated, service_role'"
    )
    expect(migration).toContain("'service_role', 'arena.position_history', 'TRUNCATE'")
    expect(migration).toContain("privilege.privilege_type = 'TRUNCATE'")
    expect(migration).toContain("default_acl.defaclnamespace = 'arena'::pg_catalog.regnamespace")
  })

  it('updates the compatibility cursor only after receipt and exact-row binding succeed', () => {
    const receiptInsert = writer.indexOf('INSERT INTO arena.record_surface_publications')
    const typedUpsert = writer.indexOf('INSERT INTO arena.position_history', receiptInsert)
    const exactCountGate = writer.indexOf(
      'v_bound_count IS DISTINCT FROM v_parsed_row_count',
      typedUpsert
    )
    const cursorDelete = writer.indexOf('DELETE FROM arena.ingest_cursors', exactCountGate)
    const cursorUpsert = writer.indexOf('INSERT INTO arena.ingest_cursors', cursorDelete)
    const finalReturn = writer.indexOf("'replayed', false", cursorUpsert)

    expect(receiptInsert).toBeGreaterThan(-1)
    expect(typedUpsert).toBeGreaterThan(receiptInsert)
    expect(exactCountGate).toBeGreaterThan(typedUpsert)
    expect(cursorDelete).toBeGreaterThan(exactCountGate)
    expect(cursorUpsert).toBeGreaterThan(cursorDelete)
    expect(finalReturn).toBeGreaterThan(cursorUpsert)
    expect(writer).toContain("WHERE trader_id = v_trader.id\n      AND kind = 'position_history'")
    expect(writer).toContain('ON CONFLICT (trader_id, kind) DO UPDATE SET')
    expect(writer).toContain('cursor_value = EXCLUDED.cursor_value')
    expect(writer).toContain('updated_at = EXCLUDED.updated_at')
    expect(writer).not.toMatch(
      /\bSELECT\b(?:(?!;)[\s\S])*?\bFROM(?: ONLY)?\s+arena\.ingest_cursors\b/i
    )
  })

  it('keeps receipt, row binding, and cursor mutation in one fail-closed outer transaction', () => {
    const outerSql = sql.replace(/\$([a-zA-Z0-9_]*)\$[\s\S]*?\$\1\$/g, '')
    expect(outerSql.match(/^\s*BEGIN;/gm)).toHaveLength(1)
    expect(outerSql.match(/^\s*COMMIT;/gm)).toHaveLength(1)
    expect(outerSql.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(outerSql).not.toMatch(/^\s*ROLLBACK;/gm)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL TIME ZONE 'UTC'")
    expect(migration).toContain('The worker must first persist the immutable Storage object')
    expect(migration).toContain('in its caller-owned transaction')
    expect(migration).toContain('does not by itself prove parser coverage, price/cost basis')

    expect(withoutComments(writer)).not.toMatch(
      /\b(?:START TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT)\b/i
    )
    expect(writer.match(/INSERT INTO arena\.record_surface_publications/g)).toHaveLength(1)
    expect(writer.match(/INSERT INTO arena\.position_history/g)).toHaveLength(1)
    expect(writer.match(/(?:INSERT INTO|DELETE FROM) arena\.ingest_cursors/g)).toHaveLength(2)
    expect(writer).toContain('verified position-history replay conflicts with its frozen receipt')
    expect(writer).toContain('verified position-history publication is stale')
    expect(writer).toContain('verified position-history rows conflict with existing typed data')
  })

  it('preflights the private verified-row substrate and refuses partial installation', () => {
    expect(migration).toContain(
      "'arena.get_position_history_publication_checkpoint(smallint,bigint)'"
    )
    expect(migration).toContain(
      "'arena.position_history_publication_chain_healthy(bigint,smallint,bigint)'"
    )
    expect(migration).toContain(
      "'arena.publish_verified_position_history(bigint,bigint,timestamptz,jsonb,text,text)'"
    )
    expect(migration).toContain(
      'verified position-history writer is already or partially installed'
    )
    expect(migration).toContain("attribute_row.attname = 'verified_publication_id'")
    expect(migration).toContain(
      "constraint_row.conname = 'position_history_verified_publication_fkey'"
    )
    expect(migration).toContain("constraint_row.confdeltype = 'r'")
    expect(migration).toContain('AND constraint_row.convalidated')
    expect(migration).toContain(
      "pg_catalog.has_table_privilege('anon', 'arena.position_history', 'SELECT')"
    )
    expect(migration).toContain("'authenticated', 'arena.position_history', 'SELECT'")
    expect(migration).toContain("'arena.record_surface_publications'::pg_catalog.regclass")
    expect(migration).toContain('verified position-history private read boundary drifted')
  })
})
