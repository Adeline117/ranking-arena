import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationName = '20260803100000_record_surface_publication_substrate.sql'
const migration = readFileSync(join(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

function section(startMarker: string, endMarker: string): string {
  const start = migration.indexOf(startMarker)
  const end = migration.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`migration section not found: ${startMarker} -> ${endMarker}`)
  }
  return migration.slice(start, end)
}

const receiptTable = section(
  'CREATE TABLE arena.record_surface_publications',
  'CREATE UNIQUE INDEX uidx_record_surface_publication_raw_object'
)
const receiptMutationGuard = section(
  'CREATE FUNCTION arena.reject_record_surface_publication_mutation()',
  'CREATE TRIGGER record_surface_publication_reject_update_delete'
)
const rawMutationGuard = section(
  'CREATE FUNCTION arena.protect_record_surface_publication_raw_object()',
  'CREATE TRIGGER protect_record_surface_publication_raw_before_write'
)

describe('record surface publication substrate migration', () => {
  it('runs once inside one bounded outer transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("SET LOCAL TIME ZONE 'UTC'")
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp')
    expect(migration).toContain(
      "pg_catalog.hashtextextended('20260803-record-surface-publication-substrate', 0)"
    )
    expect(migration).toContain('LOCK TABLE ONLY arena.position_history IN ACCESS EXCLUSIVE MODE')
  })

  it('creates a private owner-only immutable receipt ledger', () => {
    expect(migration).toContain('CREATE TABLE arena.record_surface_publications')
    expect(migration).toContain(
      'ALTER TABLE arena.record_surface_publications ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).toContain(
      'ALTER TABLE arena.record_surface_publications FORCE ROW LEVEL SECURITY'
    )
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]*?ON arena\.record_surface_publications/i)
    expect(migration).toContain('ALTER TABLE arena.record_surface_publications OWNER TO postgres')
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE arena\.record_surface_publications\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON SEQUENCE arena\.record_surface_publications_publication_id_seq\s+FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toContain("'service_role', 'arena.record_surface_publications', 'SELECT'")

    expect(migration).toMatch(
      /CREATE TRIGGER record_surface_publication_reject_update_delete\s+BEFORE UPDATE OR DELETE ON arena\.record_surface_publications/
    )
    expect(migration).toMatch(
      /CREATE TRIGGER record_surface_publication_reject_truncate\s+BEFORE TRUNCATE ON arena\.record_surface_publications/
    )
    expect(receiptMutationGuard).toContain(
      "RAISE EXCEPTION 'record surface publication receipts are immutable'"
    )
    expect(receiptMutationGuard).toContain("USING ERRCODE = '55000'")
  })

  it('adds only a nullable verified receipt binding and a verified-row page index', () => {
    expect(migration).toMatch(
      /ALTER TABLE arena\.position_history\s+ADD COLUMN verified_publication_id bigint,/
    )
    expect(migration).toMatch(
      /CONSTRAINT position_history_verified_publication_fkey\s+FOREIGN KEY \(verified_publication_id\)\s+REFERENCES arena\.record_surface_publications\(publication_id\)\s+ON DELETE RESTRICT;/
    )
    expect(migration).toMatch(
      /CREATE INDEX idx_arena_position_history_verified_trader_page\s+ON arena\.position_history \(trader_id, closed_at DESC, dedupe_hash DESC\)\s+WHERE verified_publication_id IS NOT NULL;/
    )
    expect(migration).not.toMatch(/verified_publication_id\s+bigint\s+NOT NULL/)
    expect(migration).not.toMatch(/UPDATE\s+(?:ONLY\s+)?arena\.position_history/i)
    expect(migration).toContain(
      "'NULL means unverified/legacy and must never be served as complete or used for ranking. Non-NULL bindings are written only by the evidence-bound publication RPC.'"
    )
  })

  it('installs no writer, reader, or public RPC in the substrate phase', () => {
    const createdFunctions = [...migration.matchAll(/^CREATE FUNCTION ([a-z0-9_.]+)\(/gim)].map(
      (match) => match[1]
    )
    expect(createdFunctions).toEqual([
      'arena.reject_record_surface_publication_mutation',
      'arena.protect_record_surface_publication_raw_object',
    ])
    expect(migration).not.toMatch(/^CREATE OR REPLACE FUNCTION /gim)
    expect(migration).not.toMatch(/^CREATE FUNCTION public\./gim)
    expect(migration).not.toMatch(/\bGRANT\s+EXECUTE\b/i)
    expect(migration).not.toMatch(/\bINSERT\s+INTO\s+arena\.record_surface_publications\b/i)
    expect(migration).not.toMatch(/\bUPDATE\s+arena\.position_history\b/i)
  })

  it('tombstones normal RAW GC but protects every bound RAW identity field and quarantine', () => {
    expect(receiptTable).toMatch(
      /raw_object_id bigint\s+REFERENCES arena\.raw_objects\(id\) ON DELETE SET NULL/
    )
    for (const retainedField of [
      'raw_storage_path text NOT NULL',
      'raw_content_hash text NOT NULL',
      'raw_fetched_at timestamptz NOT NULL',
      'source_run_id text NOT NULL',
    ]) {
      expect(receiptTable).toContain(retainedField)
    }
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX uidx_record_surface_publication_raw_object\s+ON arena\.record_surface_publications \(raw_object_id\)\s+WHERE raw_object_id IS NOT NULL;/
    )

    expect(receiptMutationGuard).toContain('pg_catalog.pg_trigger_depth() > 1')
    expect(receiptMutationGuard).toContain('OLD.raw_object_id IS NOT NULL')
    expect(receiptMutationGuard).toContain('NEW.raw_object_id IS NULL')
    expect(receiptMutationGuard).toContain("pg_catalog.to_jsonb(NEW) - 'raw_object_id'")
    expect(receiptMutationGuard).toContain("pg_catalog.to_jsonb(OLD) - 'raw_object_id'")

    expect(migration).toMatch(
      /CREATE TRIGGER protect_record_surface_publication_raw_before_write\s+BEFORE UPDATE OR DELETE ON arena\.raw_objects/
    )
    expect(rawMutationGuard).toContain('WHERE publication.raw_object_id = OLD.id')
    expect(rawMutationGuard).toContain('IF OLD.quarantined THEN')
    expect(rawMutationGuard).toContain(
      "RAISE EXCEPTION 'quarantined record publication RAW evidence cannot be deleted'"
    )
    expect(rawMutationGuard).toContain('AND NOT (NOT OLD.quarantined AND NEW.quarantined)')
    for (const field of [
      'id',
      'source_id',
      'job_type',
      'trader_id',
      'timeframe',
      'fetched_at',
      'storage_path',
      'bytes',
      'content_hash',
      'meta',
      'source_run_id',
      'trust_artifact_role',
    ]) {
      expect(rawMutationGuard).toContain(`NEW.${field} IS DISTINCT FROM OLD.${field}`)
    }
  })

  it('revokes direct browser reads from the parent and every existing partition', () => {
    expect(migration).toContain(
      'DROP POLICY "Public read position_history" ON arena.position_history'
    )
    expect(migration).toContain(
      'REVOKE SELECT ON TABLE arena.position_history FROM PUBLIC, anon, authenticated'
    )
    expect(migration).toContain(
      "WHERE inheritance.inhparent = 'arena.position_history'::pg_catalog.regclass"
    )
    expect(migration).toContain("'REVOKE SELECT ON TABLE %s FROM PUBLIC, anon, authenticated'")
    expect(migration).toContain("'ALTER TABLE %s ENABLE ROW LEVEL SECURITY'")
    expect(migration).not.toMatch(/GRANT\s+SELECT\s+ON\s+(?:TABLE\s+)?arena\.position_history/i)
    expect(migration).toContain("'anon', 'arena.position_history', 'SELECT'")
    expect(migration).toContain("'authenticated', 'arena.position_history', 'SELECT'")
    expect(migration).toMatch(
      /WHERE policy_row\.polrelid IN \(\s*'arena\.record_surface_publications'::pg_catalog\.regclass,\s*'arena\.position_history'::pg_catalog\.regclass\s*\)/
    )
  })

  it('removes inherited browser SELECT from future postgres-owned Arena tables', () => {
    expect(migration).toMatch(
      /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena\s+REVOKE SELECT ON TABLES FROM anon, authenticated;/
    )
    expect(
      migration.indexOf('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena')
    ).toBeLessThan(migration.indexOf('CREATE TABLE arena.record_surface_publications'))
  })

  it('admits only contract-bound verified terminal evidence with separated clocks', () => {
    for (const token of [
      "surface text NOT NULL CHECK (surface = 'position_history')",
      "lane text NOT NULL CHECK (lane IN ('tier_b', 'history_backfill', 'replay'))",
      "source_run_id ~ '^[0-9a-f]{64}$'",
      "source_run_id <> pg_catalog.repeat('0', 64)",
      'raw_content_hash = source_run_id',
      'pg_catalog.isfinite(raw_fetched_at)',
      'observed_at = raw_fetched_at',
      'source_as_of timestamptz CHECK (source_as_of IS NULL)',
      'published_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()',
      "observed_at <= published_at + interval '5 minutes'",
      "evidence_contract = 'arena.position-history-publication-evidence@1'",
      "data_contract = 'arena.ingest.history-acquisition-artifact@1'",
      'page_count > 0 AND page_count <= 100000',
      'parsed_row_count >= 0 AND parsed_row_count <= 10000000',
      "row_set_sha256 ~ '^[0-9a-f]{64}$'",
      "pg_catalog.jsonb_typeof(termination) = 'object'",
      "termination->>'evidence_state' IS NOT DISTINCT FROM 'verified'",
      "termination->'blocker_reasons' IS NOT DISTINCT FROM '[]'::jsonb",
      "termination->>'scan_terminal_state' IS NOT DISTINCT FROM scan_terminal_state",
      "termination->>'verifier_contract' IS NOT DISTINCT FROM verifier_contract",
    ]) {
      expect(receiptTable).toContain(token)
    }

    expect(receiptTable).toMatch(
      /verifier_contract ~\s*'\^arena\\\.ingest\\\.history-terminal-verifier/
    )
    expect(receiptTable).toMatch(
      /publisher_contract ~\s*'\^arena\\\.ingest\\\.position-history-publisher/
    )
    expect(receiptTable).toContain("scan_terminal_state IN ('exhausted', 'cursor_overlap')")
    expect(receiptTable).not.toMatch(/scan_terminal_state IN \([^)]*partial/)
    expect(receiptTable).not.toMatch(/lane[^\n]*tier_c/)

    expect(receiptTable).toContain("scan_terminal_state = 'exhausted'")
    expect(receiptTable).toContain('AND starting_cursor IS NULL')
    expect(receiptTable).toContain('AND overlap_event_at IS NULL')
    expect(receiptTable).toContain(
      "termination->'terminal_cursor_value' IS NOT DISTINCT FROM 'null'::jsonb"
    )
    expect(receiptTable).toContain("scan_terminal_state = 'cursor_overlap'")
    expect(receiptTable).toContain('AND starting_cursor IS NOT NULL')
    expect(receiptTable).toContain('AND effective_cursor_after IS NOT NULL')
    expect(receiptTable).toContain('AND overlap_event_at <= starting_cursor')
    expect(receiptTable).toContain(
      "(termination->>'terminal_cursor_value')::timestamptz\n          IS NOT DISTINCT FROM starting_cursor"
    )
    expect(receiptTable).toContain(
      "(termination->>'overlap_event_at')::timestamptz\n          IS NOT DISTINCT FROM overlap_event_at"
    )
    expect(receiptTable).toContain('effective_cursor_after >= starting_cursor')
    expect(receiptTable).toMatch(
      /previous_publication_id bigint\s+REFERENCES arena\.record_surface_publications\(publication_id\)\s+ON DELETE RESTRICT/
    )
    expect(receiptTable).toContain('previous_publication_id <> publication_id')
  })
})
