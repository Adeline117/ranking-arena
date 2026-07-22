import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260722040000_leaderboard_acquisition_manifest_v3_compat.sql'
  ),
  'utf8'
)

const startRpc = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION arena.start_leaderboard_acquisition_attempt'),
  migration.indexOf('CREATE OR REPLACE FUNCTION arena.finish_leaderboard_acquisition_attempt')
)
const finishRpc = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION arena.finish_leaderboard_acquisition_attempt'),
  migration.indexOf('REVOKE ALL ON FUNCTION arena.start_leaderboard_acquisition_attempt')
)

describe('leaderboard acquisition manifest v3 compatibility migration', () => {
  it('is an additive atomic compatibility phase, not the v2 retirement', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('both verified contracts may begin and finish')
    expect(migration).toContain('separately deployed migration may retire only fresh v2 begins')
    expect(migration).not.toMatch(/@2 is retired|retired for new attempts/)
    expect(migration).not.toMatch(/CREATE OR REPLACE VIEW arena\.score_inputs\b/)
    expect(migration).not.toMatch(/leaderboard_ranks\b/)
  })

  it('widens the exact existing constraints and registers one reviewed Binance v3 row', () => {
    expect(migration).toContain(
      'DROP CONSTRAINT leaderboard_capture_contracts_capture_contract_check'
    )
    expect(migration).toContain(
      'ADD CONSTRAINT leaderboard_capture_contracts_capture_contract_check'
    )
    expect(migration).toContain(
      'DROP CONSTRAINT leaderboard_acquisition_attempts_capture_contract_check'
    )
    expect(migration).toContain(
      'ADD CONSTRAINT leaderboard_acquisition_attempts_capture_contract_check'
    )
    expect(migration).toMatch(
      /leaderboard_capture_contracts_capture_contract_check[\s\S]*capture_contract IN \([\s\S]*leaderboard-acquisition-manifest@2[\s\S]*leaderboard-acquisition-manifest@3/
    )
    expect(migration).toMatch(
      /leaderboard_acquisition_attempts_capture_contract_check[\s\S]*capture_contract IN \([\s\S]*leaderboard-acquisition-manifest@2[\s\S]*leaderboard-acquisition-manifest@3[\s\S]*legacy_unverified/
    )

    const registryInsert = migration.indexOf('INSERT INTO arena.leaderboard_capture_contracts')
    expect(registryInsert).toBeGreaterThan(
      migration.indexOf('ALTER TABLE arena.leaderboard_acquisition_attempts')
    )
    const registration = migration.slice(registryInsert, migration.indexOf('END\n$register_v3$;'))
    expect(registration).toContain("'arena.ingest.leaderboard-acquisition-manifest@3'")
    expect(registration).toContain("source.slug = 'binance_futures'")
    expect(registration).toContain("source.adapter_slug = 'binance'")
    expect(registration).toContain("'arena.ingest.leaderboard-acquisition-manifest@2'")
    expect(registration).toContain('capture.attempt_binding_contract')
    expect(registration).toContain('capture.requires_runner_git_sha')
    expect(registration).toContain('GET DIAGNOSTICS v_inserted = ROW_COUNT')
    expect(registration).toContain('IF v_inserted <> 1 THEN')
    expect(migration).not.toMatch(/(?:UPDATE|DELETE FROM) arena\.leaderboard_capture_contracts/)
  })

  it('uses complete explicit RPC replacements and preserves exact replay semantics', () => {
    expect(migration.match(/CREATE OR REPLACE FUNCTION arena\./g)).toHaveLength(2)
    expect(migration).not.toMatch(/pg_get_functiondef|EXECUTE\s+format\s*\(/)

    for (const rpc of [startRpc, finishRpc]) {
      expect(rpc).toMatch(
        /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
      )
      expect(rpc).toContain('pg_catalog.pg_advisory_xact_lock')
      expect(rpc).toContain("USING ERRCODE = '22023'")
    }

    expect(startRpc).toMatch(
      /p_capture_contract NOT IN \([\s\S]*leaderboard-acquisition-manifest@2[\s\S]*leaderboard-acquisition-manifest@3[\s\S]*legacy_unverified/
    )
    expect(startRpc).not.toMatch(/@2 is retired|retired for new attempts/)
    expect(startRpc.indexOf('IF FOUND THEN')).toBeLessThan(startRpc.indexOf('INTO STRICT v_source'))
    expect(startRpc).toContain('attempt id replay conflicts with prior begin')

    expect(finishRpc).toMatch(
      /v_attempt\.capture_contract IN \([\s\S]*leaderboard-acquisition-manifest@2[\s\S]*leaderboard-acquisition-manifest@3[\s\S]*p_capture_evidence_state NOT IN/
    )
    expect(finishRpc).toMatch(
      /verified capture RAW evidence[\s\S]*v_attempt\.capture_contract NOT IN \([\s\S]*leaderboard-acquisition-manifest@2[\s\S]*leaderboard-acquisition-manifest@3/
    )
    expect(finishRpc).toMatch(
      /p_terminal_state IN \('complete', 'partial'\)[\s\S]*v_attempt\.capture_contract NOT IN \([\s\S]*leaderboard-acquisition-manifest@2[\s\S]*leaderboard-acquisition-manifest@3/
    )
    expect(finishRpc).toContain(
      "v_manifest.meta->>'data_contract' IS DISTINCT FROM v_attempt.capture_contract"
    )
    expect(finishRpc).toContain("->>'attempt_id'")
    expect(finishRpc).toContain("->>'attempt_seq'")
    expect(finishRpc).toContain('v_manifest.content_hash IS DISTINCT FROM p_source_run_id')
    expect(finishRpc.indexOf('IF FOUND THEN')).toBeLessThan(
      finishRpc.indexOf('FROM arena.raw_objects')
    )
  })

  it('retains evidence ownership, owner identity, ACLs, and postflight checks', () => {
    expect(migration).not.toMatch(/DROP INDEX/)
    for (const index of [
      'uidx_leaderboard_acquisition_outcomes_source_run',
      'uidx_leaderboard_acquisition_outcomes_source_payload',
      'uidx_leaderboard_acquisition_outcomes_manifest',
      'uidx_leaderboard_acquisition_outcomes_diagnostic',
    ]) {
      expect(migration).toContain(index)
    }
    for (const rpc of [
      'arena.start_leaderboard_acquisition_attempt',
      'arena.finish_leaderboard_acquisition_attempt',
    ]) {
      expect(migration).toContain(`ALTER FUNCTION ${rpc}(`)
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${rpc}(`)
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${rpc}(`)
    }
    expect(migration).toContain(') OWNER TO postgres;')
    expect(migration).toContain(
      "NOT pg_catalog.has_function_privilege('service_role', v_start, 'EXECUTE')"
    )
    expect(migration).toContain("pg_catalog.has_function_privilege('anon', v_start, 'EXECUTE')")
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
