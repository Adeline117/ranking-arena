import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql'
  ),
  'utf8'
)

const startRpc = migration.slice(
  migration.indexOf('CREATE FUNCTION arena.start_leaderboard_acquisition_attempt'),
  migration.indexOf('CREATE FUNCTION arena.finish_leaderboard_acquisition_attempt')
)
const finishRpc = migration.slice(
  migration.indexOf('CREATE FUNCTION arena.finish_leaderboard_acquisition_attempt'),
  migration.indexOf('CREATE VIEW arena.leaderboard_acquisition_attempt_states')
)

describe('durable leaderboard acquisition attempt ledger migration', () => {
  it('is one atomic private shadow substrate and leaves live ranking surfaces unchanged', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).not.toMatch(/CREATE OR REPLACE VIEW arena\.score_inputs\b/)
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.arena_score_inputs_json/)
    expect(migration).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\s+(?:FROM\s+|INTO\s+)?leaderboard_ranks\b/i
    )
    expect(migration).toContain('authorize public ranking')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('separates immutable starts and terminals with a database sequence fence', () => {
    expect(migration).toContain('CREATE TABLE arena.leaderboard_capture_contracts')
    expect(migration).toContain('CREATE TABLE arena.leaderboard_acquisition_attempts')
    expect(migration).toContain('CREATE TABLE arena.leaderboard_acquisition_outcomes')
    expect(migration).toMatch(
      /attempt_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY[\s\S]*attempt_id uuid NOT NULL UNIQUE/
    )
    expect(migration).toContain(
      'attempt_seq bigint PRIMARY KEY\n    REFERENCES arena.leaderboard_acquisition_attempts(attempt_seq) ON DELETE RESTRICT'
    )
    expect(migration).not.toMatch(
      /UNIQUE\s*\([^)]*(?:observation_cycle_id|source_id[^)]*timeframe)/
    )
    expect(migration).toContain("WHERE source.slug = 'binance_futures'")
    expect(migration).toContain("AND source.adapter_slug = 'binance'")
    expect(startRpc).toContain('is not registered for source')
    expect(startRpc).toContain('requires a full runner git SHA')
    expect(startRpc).toContain("p_runner_git_sha = pg_catalog.repeat('0', 40)")
    expect(startRpc).toContain(
      "pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())"
    )
    expect(migration).toContain(
      'ALTER FUNCTION arena.start_leaderboard_acquisition_attempt(\n' +
        '  uuid, integer, integer, text, text, integer, text, text, text\n' +
        ') OWNER TO postgres;'
    )
  })

  it('keeps RAW references soft while freezing their immutable identities', () => {
    for (const token of [
      'source_payload_raw_object_id bigint',
      'source_payload_content_hash text',
      'source_payload_storage_path text',
      'manifest_raw_object_id bigint',
      'manifest_content_hash text',
      'manifest_storage_path text',
      'diagnostic_raw_object_id bigint',
      'diagnostic_content_hash text',
      'diagnostic_storage_path text',
    ]) {
      expect(migration).toContain(token)
    }
    expect(migration).not.toMatch(
      /(?:source_payload|manifest|diagnostic)_raw_object_id bigint[^,]*REFERENCES arena\.raw_objects/
    )
    expect(finishRpc).toContain('FROM arena.raw_objects')
    expect(finishRpc).toContain("trust_artifact_role IS DISTINCT FROM 'source_payload'")
    expect(finishRpc).toContain("trust_artifact_role IS DISTINCT FROM 'population_manifest'")
    expect(finishRpc).toContain('v_manifest.content_hash IS DISTINCT FROM p_source_run_id')
    expect(finishRpc).toContain('v_source_payload.quarantined')
    expect(finishRpc).toContain('v_manifest.quarantined')
    expect(finishRpc).toContain("v_source_payload.content_hash = pg_catalog.repeat('0', 64)")
    expect(finishRpc).toContain('capture start must equal the database attempt start')
    expect(finishRpc).toMatch(
      /FROM arena\.raw_objects AS raw_object[\s\S]*ORDER BY raw_object\.id[\s\S]*FOR UPDATE;/
    )
    for (const token of [
      "->>'binding_contract'",
      "->>'attempt_id'",
      "->>'attempt_seq'",
      "->>'runner_git_sha'",
      "->>'capture_started_at'",
      "->>'capture_completed_at'",
      "->>'capture_evidence_state'",
      "->>'termination_reason'",
      "->>'population_report_state'",
      "->>'page_count_report_state'",
      "->>'observed_population'",
      "->>'accepted_population'",
      "->>'rejected_row_count'",
      "->>'deduplicated_row_count'",
      "->>'caller_limited'",
      "->>'safety_limited'",
      "->>'acquisition_state'",
      "->>'population_state'",
    ]) {
      expect(finishRpc).toContain(token)
    }
    for (const index of [
      'uidx_leaderboard_acquisition_outcomes_source_run',
      'uidx_leaderboard_acquisition_outcomes_source_payload',
      'uidx_leaderboard_acquisition_outcomes_manifest',
      'uidx_leaderboard_acquisition_outcomes_diagnostic',
    ]) {
      expect(migration).toContain(`CREATE UNIQUE INDEX ${index}`)
    }
    expect(migration).toContain(
      'CREATE FUNCTION arena.protect_leaderboard_acquisition_raw_evidence()'
    )
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON arena.raw_objects')
  })

  it('makes begin and finish exact-replay RPCs with deterministic locking', () => {
    for (const rpc of [startRpc, finishRpc]) {
      expect(rpc).toMatch(
        /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
      )
      expect(rpc).toContain('pg_catalog.pg_advisory_xact_lock')
      expect(rpc).toContain("USING ERRCODE = '22023'")
    }
    expect(startRpc).toContain('attempt id replay conflicts with prior begin')
    expect(startRpc.indexOf('IF FOUND THEN')).toBeLessThan(startRpc.indexOf('INTO STRICT v_source'))
    expect(finishRpc).toContain('FOR UPDATE')
    expect(finishRpc).toContain('finish replay conflicts with terminal outcome')
    expect(finishRpc.indexOf('IF FOUND THEN')).toBeLessThan(
      finishRpc.indexOf('FROM arena.raw_objects')
    )
  })

  it('restores the transaction-local insert path after both success and error', () => {
    expect(startRpc.match(/COALESCE\(v_prior_path, ''\)/g)).toHaveLength(2)
    expect(finishRpc.match(/COALESCE\(v_prior_path, ''\)/g)).toHaveLength(2)
    expect(migration).toContain(
      'CREATE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation()'
    )
    expect(migration).toContain('BEFORE INSERT OR UPDATE OR DELETE')
    expect(migration).toContain('BEFORE TRUNCATE')
  })

  it('encodes complete, partial, unknown, failed, and abandoned without free-form errors', () => {
    for (const state of ['complete', 'partial', 'unknown', 'processing_failed', 'abandoned']) {
      expect(migration).toContain(`'${state}'`)
    }
    for (const status of ['started', 'succeeded', 'partial', 'unknown', 'failed']) {
      expect(migration).toContain(`'${status}'`)
    }
    expect(migration).toContain('failure_stage text CHECK')
    expect(migration).toContain('reason_code text CHECK')
    expect(migration).not.toMatch(/(?:error|failure)_(?:message|detail)\s+text/i)
    expect(migration).toContain('accepted_population = reported_population')
    expect(migration).toContain('rejected_row_count = 0')
    expect(migration).toContain('observed_population IS NOT NULL')
    expect(migration).toContain('accepted_population IS NOT NULL')
    expect(migration).toContain('deduplicated_row_count IS NOT NULL')
    expect(migration).toContain("page_count_report_state IN ('consistent', 'unknown')")
    expect(migration).toContain('source_page_count = reported_page_count')
    expect(migration).toContain('reported_page_count + 1')
    expect(migration).toContain("termination_reason <> 'reported_page_count_reached'")
    expect(migration).toContain("termination_reason <> 'single_snapshot' OR source_page_count = 1")
    expect(migration).toContain('observed_population >= reported_population')
    expect(migration).toContain("population_report_state = 'unknown'")
    expect(migration).toContain("termination_reason <> 'reported_population_reached'")
    expect(migration).toMatch(
      /CONSTRAINT leaderboard_acquisition_population_report_shape CHECK \(\([\s\S]*?\) IS TRUE\)/
    )
    expect(migration).toMatch(
      /CONSTRAINT leaderboard_acquisition_page_report_shape CHECK \(\([\s\S]*?\) IS TRUE\)/
    )
    expect(migration).toMatch(
      /CONSTRAINT leaderboard_acquisition_terminal_shape CHECK \(\([\s\S]*?\) IS TRUE\)/
    )
    expect(migration).toContain('legacy acquisition cannot claim complete or partial evidence')
    expect(finishRpc).toContain('capture evidence state does not match the attempt contract')
    expect(migration).toMatch(
      /ALTER FUNCTION arena\.finish_leaderboard_acquisition_attempt\([\s\S]*?\) OWNER TO postgres;/
    )
  })

  it('distinguishes latest physical work from latest terminal evidence', () => {
    expect(migration).toContain('CREATE VIEW arena.latest_leaderboard_acquisition_attempts')
    expect(migration).toContain('CREATE VIEW arena.latest_terminal_leaderboard_acquisitions')
    expect(migration).toMatch(
      /CREATE VIEW arena\.latest_leaderboard_acquisition_attempts[\s\S]*ORDER BY state\.source_id, state\.timeframe, state\.attempt_seq DESC;/
    )
    expect(migration).toMatch(
      /CREATE VIEW arena\.latest_terminal_leaderboard_acquisitions[\s\S]*WHERE state\.recorded_completed_at IS NOT NULL[\s\S]*ORDER BY state\.source_id, state\.timeframe, state\.attempt_seq DESC;/
    )
    expect(migration).not.toMatch(
      /ORDER BY state\.source_id, state\.timeframe, state\.(?:recorded_started_at|recorded_completed_at)/
    )
    expect(migration).toContain('A started crawl does not invalidate prior fresh evidence')
  })

  it('is service-read/RPC-only and revokes inherited arena defaults', () => {
    for (const relation of [
      'leaderboard_capture_contracts',
      'leaderboard_acquisition_attempts',
      'leaderboard_acquisition_outcomes',
      'leaderboard_acquisition_attempt_states',
      'latest_leaderboard_acquisition_attempts',
      'latest_terminal_leaderboard_acquisitions',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON TABLE arena.${relation}`)
      expect(migration).toContain(`GRANT SELECT ON TABLE arena.${relation} TO service_role`)
    }
    expect(migration).toContain(
      'REVOKE ALL ON SEQUENCE arena.leaderboard_acquisition_attempts_attempt_seq_seq'
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.start_leaderboard_acquisition_attempt\([\s\S]*?\) TO service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.finish_leaderboard_acquisition_attempt\([\s\S]*?\) TO service_role;/
    )
    expect(migration).not.toMatch(
      /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE|ALL)[^;]*leaderboard_(?:capture_contracts|acquisition_(?:attempts|outcomes))/
    )
    expect(migration).toContain(
      'CREATE FUNCTION arena.reject_leaderboard_capture_contract_mutation()'
    )
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON arena.leaderboard_capture_contracts')
    expect(migration).toContain('BEFORE TRUNCATE ON arena.leaderboard_capture_contracts')
    expect(migration).toContain(
      'integer, integer, integer, integer, boolean, boolean, text, text\n) TO service_role;'
    )
  })
})
