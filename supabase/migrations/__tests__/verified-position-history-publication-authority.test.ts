import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const prerequisite = readFileSync(
  join(root, 'supabase/migrations/20260804045000_verified_position_history_raw_prerequisites.sql'),
  'utf8'
)
const migration = readFileSync(
  join(
    root,
    'supabase/migrations/20260804050000_verified_position_history_publication_authority.sql'
  ),
  'utf8'
)
const pg17Proof = readFileSync(
  join(
    root,
    'supabase/migrations/__tests__/verified-position-history-publication-authority.pg17.sh'
  ),
  'utf8'
)

const section = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)

  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('verified position-history RAW admission prerequisite', () => {
  it('stays compatible with the original eleven-column RAW table', () => {
    expect(prerequisite).toMatch(/^-- Short, base-RAW-compatible admission boundary/)
    expect(prerequisite).toContain("'the eleven-column Arena RAW contract is absent or drifted'")
    expect(prerequisite).toContain("'arena.ingest.history-acquisition-artifact@1'")
    expect(prerequisite).toContain("'arena.position-history-publication-evidence@2'")
    expect(prerequisite).toContain('CREATE TABLE arena.position_history_raw_admissions (')
    expect(prerequisite).toContain('raw_meta_sha256 text NOT NULL')
    expect(prerequisite).toContain('raw_snapshot_sha256 text NOT NULL UNIQUE')
    expect(prerequisite).toContain('admitted_transaction_id xid8 NOT NULL')
    expect(prerequisite).not.toMatch(/ALTER TABLE(?: ONLY)? arena\.raw_objects\s+ADD/i)
    expect(prerequisite.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('admits eligible RAW only from the guarded AFTER INSERT transaction', () => {
    const admission = section(
      prerequisite,
      'CREATE FUNCTION arena.require_position_history_raw_admission_context',
      'CREATE FUNCTION arena.reject_position_history_raw_admission_mutation'
    )

    expect(admission).toContain('pg_catalog.pg_trigger_depth() <> 2')
    expect(admission).toContain('pg_catalog.pg_current_xact_id()')
    expect(admission).toContain("'arena.position_history_raw_admission_context'")
    expect(admission).toContain('arena.position_history_raw_snapshot_sha256(')
    expect(admission).toContain(
      'position-history RAW admission requires its guarded INSERT transaction'
    )
    expect(prerequisite).toContain(
      'CREATE TRIGGER admit_position_history_raw_after_insert\nAFTER INSERT ON arena.raw_objects'
    )
    expect(prerequisite).toContain('CREATE INDEX position_history_raw_admissions_source_id_idx')
    expect(prerequisite).toContain('CREATE INDEX position_history_raw_admissions_trader_id_idx')
  })

  it('permits row locking but makes every admission mutation fail closed', () => {
    const lockPolicy = section(
      prerequisite,
      'CREATE POLICY owner_position_history_raw_admission_lock',
      'CREATE FUNCTION arena.require_position_history_raw_admission_context'
    )

    expect(lockPolicy).toContain('FOR UPDATE TO postgres')
    expect(lockPolicy).toContain('USING (true)')
    expect(lockPolicy).toContain('WITH CHECK (false)')
    expect(prerequisite).toContain(
      "policy_row.polname = 'owner_position_history_raw_admission_lock'"
    )
    expect(prerequisite).toContain("policy_row.polcmd = 'w'")
    expect(prerequisite).toContain(
      "RAISE EXCEPTION 'position-history RAW admission lock policy drifted'"
    )
    expect(prerequisite).toContain(
      'BEFORE UPDATE OR DELETE ON arena.position_history_raw_admissions'
    )
    expect(prerequisite).toContain('BEFORE TRUNCATE ON arena.position_history_raw_admissions')
  })

  it('uses ALWAYS triggers for RAW, admission, source, and trader authority', () => {
    for (const token of [
      'ENABLE ALWAYS TRIGGER admit_position_history_raw_after_insert',
      'ENABLE ALWAYS TRIGGER protect_position_history_raw_evidence_before_write',
      'ENABLE ALWAYS TRIGGER reject_position_history_raw_truncate',
      'ENABLE ALWAYS TRIGGER require_position_history_raw_admission_context',
      'ENABLE ALWAYS TRIGGER reject_position_history_raw_admission_row_mutation',
      'ENABLE ALWAYS TRIGGER reject_position_history_raw_admission_truncate',
      'ENABLE ALWAYS TRIGGER protect_position_history_source_identity',
      'ENABLE ALWAYS TRIGGER reject_position_history_source_truncate',
      'ENABLE ALWAYS TRIGGER protect_position_history_trader_identity',
      'ENABLE ALWAYS TRIGGER reject_position_history_trader_truncate',
    ]) {
      expect(prerequisite).toContain(token)
    }
    expect(prerequisite).toContain("trigger_row.tgenabled = 'A'")
    expect(prerequisite).toContain(
      "RAISE EXCEPTION 'position-history RAW admission trigger set drifted'"
    )
  })
})

describe('verified position-history publication authority migration', () => {
  it('is serialized, bounded, PG17-only, and fail-closed on partial installation', () => {
    expect(migration).toMatch(/^-- Verified, immutable publication authority/)
    expect(migration).toContain('\nBEGIN;')
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("SET LOCAL TIME ZONE 'UTC'")
    expect(migration).toContain("current_setting('server_version_num')::integer / 10000 <> 17")
    expect(migration).toContain('20260804050000-verified-position-history-authority-v1')
    expect(migration).toContain("to_regprocedure('extensions.hmac(bytea,bytea,text)')")
    expect(migration).toContain("to_regprocedure('extensions.gen_random_bytes(integer)')")
    expect(migration).toMatch(
      /to_regprocedure\(\s*'arena\.position_history_raw_is_eligible\(text,jsonb\)'\s*\)/
    )
    expect(migration).toContain('is already or partially installed')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('stores the three exact reviewed source contracts and @2 terminal verifiers', () => {
    const registry = section(
      migration,
      'CREATE TABLE arena.position_history_source_contracts',
      'CREATE TABLE arena.position_history_publish_guards'
    )

    expect(registry).toContain("source_currency text NOT NULL CHECK (source_currency = 'USDT')")
    expect(registry).toContain('serving_return_scale numeric NOT NULL')
    for (const token of [
      "'binance_futures'",
      "'bitget_futures'",
      "'okx_futures'",
      "'arena.ingest.position-history-parser.binance@1'",
      "'arena.ingest.position-history-parser.bitget@1'",
      "'arena.ingest.position-history-parser.okx@1'",
      "'arena.ingest.history-terminal-verifier.binance.position_history@2'",
      "'arena.ingest.history-terminal-verifier.bitget.position_history@2'",
      "'arena.ingest.history-terminal-verifier.okx.position_history@2'",
    ]) {
      expect(registry).toContain(token)
    }
    expect(migration).toContain('"returnScale":100')
    expect(migration).toContain('"returnScale":1')
    expect(migration).toContain('candidate.source_return * v_serving_return_scale')
    expect(migration).toContain("'source_return', candidate.source_return")
  })

  it('uses the @2 mixed-binding text wire and exact admission ledger snapshot', () => {
    expect(migration).toContain(
      'arena.publish_verified_position_history(\n  p_raw_object_id bigint,\n  p_source_run_id text,\n  p_previous_publication_id bigint,\n  p_publication_text text'
    )
    expect(migration).toContain(
      "publication_contract = 'arena.ingest.verified-position-history-rpc-payload@2'"
    )
    expect(migration).toContain("'bindings_canonical_json'")
    expect(migration).toContain("'binding_set_sha256'")
    expect(migration).toContain('CREATE TABLE arena.position_history_publication_bindings (')
    expect(migration).toContain(
      "classification IN ('canonical_materialized', 'source_partial_omitted')"
    )
    expect(migration).toContain('CONSTRAINT position_history_publication_binding_accounting')
    expect(migration).toContain('binding_count = parsed_row_count + partial_row_count')
    expect(migration).toContain('FROM arena.position_history_raw_admissions AS admission')
    expect(migration).toContain(
      'position-history RAW did not cross the immutable admission boundary'
    )
    expect(migration).toContain('publication binding/fact/partial counts do not equal the manifest')
    expect(migration).toContain('publication rows do not exactly bind the reviewed manifest')
    expect(migration).toContain('WITH manifest_rows AS (')
    expect(migration).not.toMatch(
      /v_seen_dedupes|v_seen_source_fact_ids|v_manifest_ordinals|array_append/
    )
  })

  it('keeps duplicate keys and canonical byte hashes exact at every text boundary', () => {
    expect(migration).toContain('CREATE FUNCTION arena.position_history_text_sha256(p_value text)')
    expect(migration).toContain(
      'CREATE FUNCTION arena.position_history_json_has_duplicate_keys(p_value json)'
    )
    expect(migration).toContain(
      'WHERE arena.position_history_json_has_duplicate_keys(object_field.value)'
    )
    expect(migration).toContain(
      'WHERE arena.position_history_json_has_duplicate_keys(array_item.value)'
    )
    for (const token of [
      'verified position-history RPC payload is not exact duplicate-free JSON',
      'bindings_canonical_json is not exact duplicate-free JSON',
      'bindings_canonical_json or binding_set_sha256 is not exact',
      'RAW row canonical byte digest is not exact',
      'RAW row canonical text is not exact duplicate-free JSON',
      'fact canonical byte digest is not exact',
      'fact canonical text is not exact duplicate-free JSON',
    ]) {
      expect(migration).toContain(token)
    }
  })

  it('binds every economic fact to exact RAW values and rejects precision ambiguity', () => {
    const matcher = section(
      migration,
      'CREATE FUNCTION arena.position_history_js_number',
      'CREATE FUNCTION arena.position_history_serving_margin_mode'
    )

    expect(matcher).toContain('pg_catalog.char_length(v_text) > 128')
    expect(matcher).toContain("v_text ~ '^0[xX][0-9a-fA-F]+$'")
    expect(matcher).toContain("v_text ~ '^0[oO][0-7]+$'")
    expect(matcher).toContain("v_text ~ '^0[bB][01]+$'")
    expect(matcher).toContain('position_history_numeric_scalar_is_publishable')
    expect(matcher).toContain("v_text ~ '^-' AND v_significand ~ '^0+$'")
    expect(migration).toContain('v_numeric NOT BETWEEN 0 AND 9007199254740991')
    expect(matcher).toContain('8640000000000000::double precision')
    expect(matcher).toContain('v_raw_id_number IS DISTINCT FROM v_opened_number')
    expect(matcher).toContain('CREATE FUNCTION arena.position_history_scaled_return_is_finite')
    expect(matcher).toContain('CREATE FUNCTION arena.position_history_ecmascript_number_text')
    expect(matcher).toContain("WHEN 'Long' THEN 'long'")
    expect(matcher).toContain("WHEN 'Short' THEN 'short'")
    expect(matcher).not.toContain("WHEN 'BUY'")
    expect(matcher).not.toContain("WHEN 'SELL'")
    expect(matcher).toContain("v_raw->>'tokenId' IS DISTINCT FROM p_source_currency")
    expect(matcher).toContain("v_raw->>'ccy' IS DISTINCT FROM p_source_currency")
    expect(migration).toContain(
      'canonical fact economic fields do not match the reviewed RAW parser'
    )
    expect(migration).toContain(
      'canonical numeric field % is not the exact ECMAScript Number spelling'
    )
  })

  it('re-proves terminal cardinality, chronology, and the exact overlap boundary', () => {
    for (const token of [
      'empty-page terminal evidence contains source rows',
      'short-page terminal cardinality is not exact',
      'cursor-overlap terminal cardinality is not exact',
      'nonterminal reviewed page cardinality is not exact',
      'reviewed completed lifecycle rows must be globally non-increasing',
      'cursor-overlap evidence does not match the exact terminal fact boundary',
    ]) {
      expect(migration).toContain(token)
    }
    expect(migration).toContain('v_page_source_row_count > v_contract.page_size')
    expect(migration).toContain(
      'v_page_source_row_count NOT BETWEEN 1 AND\n           (v_contract.page_size - 1)'
    )
    expect(migration).toContain('v_previous_page_fetched_at IS DISTINCT FROM v_observed_at')
    expect(migration).toContain('v_closed_at > v_previous_completed_closed_at')
    expect(migration).toContain('v_overlap_at IS DISTINCT FROM v_terminal_min_closed_at')
    expect(migration).toContain('OR v_prior_page_overlaps')
    expect(migration).toContain('Binance opening verifier row population does not match closing')
    expect(migration).toContain(
      'source partial binding is outside exact reviewed OKX omission evidence'
    )
    expect(migration).toContain('OKX closed fact cannot regress to a source partial omission')
  })

  it('uses immutable trader-scoped facts and a stored linear CAS chain', () => {
    const publications = section(
      migration,
      'CREATE TABLE arena.position_history_publications',
      'CREATE INDEX idx_position_history_acquisition_trader_identity'
    )
    const facts = section(
      migration,
      'CREATE TABLE arena.verified_position_history_facts',
      'CREATE INDEX idx_verified_position_history_fact_page'
    )

    expect(publications).toContain('previous_publication_id bigint')
    expect(publications).toContain('UNIQUE NULLS NOT DISTINCT (')
    expect(publications).toContain('source_id, trader_id, previous_publication_id')
    expect(publications).toContain('position_history_publication_previous_identity_fkey')
    expect(facts).toContain('UNIQUE (source_id, trader_id, dedupe_hash)')
    expect(facts).toContain('UNIQUE (source_id, trader_id, source_fact_id)')
    expect(facts).toContain("dedupe_hash ~ '^[0-9a-f]{40}$'")
    expect(facts).toContain('fact_payload jsonb NOT NULL')
    expect(migration).toContain('continuation observed_at cannot move backward')
    expect(migration).toContain('continuation lost the verified publication compare-and-swap race')
    expect(migration).toContain('source_run replay conflicts with its immutable publication')
  })

  it('serves only the latest verified authority and keeps legacy history quarantined', () => {
    const records = section(
      migration,
      'CREATE OR REPLACE FUNCTION public.arena_records_page',
      'CREATE OR REPLACE FUNCTION public.arena_source_capabilities'
    )
    const capabilities = section(
      migration,
      'CREATE OR REPLACE FUNCTION public.arena_source_capabilities',
      'REVOKE ALL ON FUNCTION public.arena_source_capabilities'
    )

    expect(records).toContain("p_source IN ('binance_futures', 'bitget_futures', 'okx_futures')")
    expect(records).toContain('AND v_contract_source_id IS NULL')
    expect(records).toContain(
      'reviewed position-history source registry no longer matches its immutable contract'
    )
    expect(records).toContain(
      'WHERE publication.trader_id = v_trader_id\n    ORDER BY publication.publication_id DESC'
    )
    expect(records).toContain('IF NOT v_anchor_identity_valid THEN')
    expect(records).toContain(
      'verified position-history identity no longer matches its immutable acquisition'
    )
    expect(records).not.toContain('FROM arena.position_history AS legacy')
    expect(records).toContain("'rows', '[]'::pg_catalog.jsonb")
    expect(records).toContain("'nextCursor', NULL")
    expect(records).toContain("'arena.position-history-completeness@2'")
    expect(records).toContain("'state', 'unknown'")
    expect(records).toContain("'state', 'complete'")
    expect(records).toContain("'^vph3[|][1-9][0-9]{0,18}[|][0-9]{1,19}[|][0-9a-f]{40}$'")
    expect(records).toContain('extensions.hmac(')
    expect(records).toContain(
      'position-history authority changed; reset pagination without a cursor'
    )
    expect(capabilities).toContain('source_row.adapter_slug = contract.adapter_slug')
    expect(capabilities).toContain('acquisition.source_run_id = publication.source_run_id')
    expect(capabilities).toContain(
      'acquisition.verifier_contract = contract.terminal_verifier_contract'
    )
    expect(capabilities).toContain('trader_row.exchange_trader_id = acquisition.exchange_trader_id')
  })

  it('installs and postflights the trader-latest hot index', () => {
    expect(migration).toContain(
      'CREATE INDEX idx_position_history_publication_trader_latest\n  ON arena.position_history_publications (trader_id, publication_id DESC);'
    )
    expect(migration).toContain("'arena.idx_position_history_publication_trader_latest'::regclass")
    expect(migration).toContain(
      "'CREATE INDEX idx_position_history_publication_trader_latest ON arena.position_history_publications USING btree (trader_id, publication_id DESC)'::text"
    )
    expect(migration).toContain("RAISE EXCEPTION 'postflight: hot identity index drifted: %'")
  })

  it('locks reviewed registry identities before adding validated FKs', () => {
    expect(migration).toContain(
      'LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE;\nLOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;'
    )
    expect(migration).toContain('FOR SHARE OF source_row;')
    expect(migration).toContain('FOR SHARE OF trader_row;')
    expect(migration).toContain("'locked position-history registry identity recheck failed'")
    expect(migration).toContain('ADD CONSTRAINT position_history_source_contract_registry_fkey')
    expect(migration).toContain('ADD CONSTRAINT position_history_acquisition_trader_fkey')
    expect(migration).toContain('ADD CONSTRAINT verified_position_history_trader_fkey')
  })

  it('postflights exact private ACL, forced RLS, policies, and ALWAYS triggers', () => {
    const postflight = migration.slice(migration.indexOf('DO $postflight$'))

    expect(migration).toContain('ALTER TABLE %s FORCE ROW LEVEL SECURITY')
    expect(migration).toContain(
      "'REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated, service_role'"
    )
    expect(migration).toContain(
      "'ALTER TABLE %s ENABLE ALWAYS TRIGGER require_verified_history_insert_guard'"
    )
    expect(migration).toContain(
      "'ALTER TABLE %s ENABLE ALWAYS TRIGGER reject_verified_history_update_delete'"
    )
    expect(migration).toContain(
      "'ALTER TABLE %s ENABLE ALWAYS TRIGGER reject_verified_history_update_delete_statement'"
    )
    expect(migration).toContain(
      "'ALTER TABLE %s ENABLE ALWAYS TRIGGER reject_verified_history_truncate'"
    )
    expect(postflight).toContain('AND table_row.relrowsecurity')
    expect(postflight).toContain('AND table_row.relforcerowsecurity')
    for (const table of [
      'arena.position_history_raw_admissions',
      'arena.position_history_source_contracts',
      'arena.position_history_acquisitions',
      'arena.position_history_publications',
      'arena.verified_position_history_facts',
      'arena.position_history_publication_bindings',
    ]) {
      expect(postflight).toContain(`'${table}'::pg_catalog.regclass`)
    }
    for (const privilege of ["'SELECT'", "'INSERT'", "'UPDATE'", "'DELETE'", "'TRUNCATE'"]) {
      expect(postflight).toContain(privilege)
    }
    expect(postflight).toContain("RAISE EXCEPTION 'postflight: private authority ACL drifted: % %'")
    expect(postflight).toContain("trigger_row.tgenabled = 'A'")
    expect(postflight).toContain(
      ") <> 20 THEN\n    RAISE EXCEPTION 'postflight: private authority trigger set drifted'"
    )
    expect(postflight).toContain("policy_row.polname = 'owner_verified_history_insert'")
    expect(postflight).toContain("'arena.position_history_publish_guard_active(source_run_id)'")
    expect(postflight).toContain("policy_row.polname = 'owner_verified_history_update'")
    expect(postflight).toContain("policy_row.polcmd = 'w'")
    expect(postflight).toContain("= 'false'")
    expect(postflight).toContain(
      "RAISE EXCEPTION 'postflight: private authority policy set drifted: %'"
    )
    expect(postflight).toContain("RAISE EXCEPTION 'postflight: source contract policy set drifted'")
    expect(postflight).toContain(
      "RAISE EXCEPTION 'postflight: publication guard ACL drifted for %'"
    )
  })

  it('keeps publisher private while retaining the public read surface', () => {
    expect(migration).toMatch(
      /CREATE FUNCTION arena\.publish_verified_position_history\([\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain("session_user IS DISTINCT FROM 'postgres'")
    expect(migration).toContain('REVOKE ALL ON FUNCTION arena.publish_verified_position_history(')
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.publish_verified_position_history/
    )
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.arena_records_page(')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.arena_source_capabilities()')
    expect(migration).toContain(
      'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'
    )
    expect(migration).toContain(
      'legacy position-history publisher is retired; parser-conservation receipt required'
    )
    expect(migration).toContain(
      "pg_catalog.has_table_privilege(\n       'anon', 'arena.position_history', 'SELECT'"
    )
    expect(migration).toContain('postflight: retired history quarantine drifted')
  })

  it('has a real PG17 proof for admission, differential parity, attacks, CAS, and reads', () => {
    expect(pg17Proof).toContain('--username=cluster_admin')
    expect(pg17Proof).toContain('CREATE ROLE postgres LOGIN NOSUPERUSER NOBYPASSRLS')
    expect(pg17Proof).toContain('CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS')
    expect(pg17Proof).toContain('owner_psql -q -f "$PREREQUISITE_MIGRATION"')
    expect(pg17Proof).toContain('owner_psql -q -f "$MIGRATION"')
    expect(pg17Proof).toContain('admission_ledger_private')
    expect(pg17Proof).toContain('direct_admission_attack')
    expect(pg17Proof).toContain('npx tsx "$EXPORTER"')
    expect(pg17Proof).toContain('if ((VECTOR_COUNT < 3000))')
    expect(pg17Proof).toContain('generate_series(1, 10000)')
    expect(pg17Proof).toContain('TS canonical byte/hash/number differential failed')
    for (const token of [
      'raw_version_type',
      'raw_bytes_fraction',
      'duplicate_outer',
      'duplicate_binding',
      'duplicate_fact',
      'duplicate_raw',
      'future_clock',
      'partial_lifecycle',
      'wrong_source_contract',
      'unrelated_raw_pointer',
      'cursor_cross_identity',
      'compare-and-swap race',
      'TRUNCATE arena.verified_position_history_facts CASCADE',
      'one-shot authority migration replayed',
    ]) {
      expect(pg17Proof).toContain(token)
    }
    expect(pg17Proof).toContain('position_history_js_number(\'"1e-9999"\'::jsonb)')
    expect(pg17Proof).toContain(
      'position_history_numeric_scalar_is_publishable(\'"-0e9999"\'::jsonb)'
    )
    expect(pg17Proof).toContain('fractional epoch or ambiguous Binance id was accepted')
    expect(pg17Proof).toContain('[verified-position-history] PostgreSQL 17 authority proof passed')
  })
})
