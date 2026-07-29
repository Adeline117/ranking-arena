import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729011000_partitioned_bot_acquisition_manifest_v4.sql'
  ),
  'utf8'
)

const preflight = migration.slice(
  migration.indexOf('DO $preflight$'),
  migration.indexOf('ALTER TABLE arena.leaderboard_capture_contracts')
)
const registration = migration.slice(
  migration.indexOf('DO $register_v4$'),
  migration.indexOf('-- The current V3 functions')
)
const rewrite = migration.slice(
  migration.indexOf('DO $upgrade_rpc_allowlists$'),
  migration.indexOf('ALTER FUNCTION arena.start_leaderboard_acquisition_attempt')
)
const postflight = migration.slice(
  migration.indexOf('DO $postflight$'),
  migration.indexOf('COMMENT ON TABLE arena.leaderboard_capture_contracts')
)

describe('partitioned Bitget bot acquisition manifest v4 migration', () => {
  it('is an atomic fail-closed admission after exact foundation and source preflights', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("SET LOCAL TIME ZONE 'UTC'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)

    expect(preflight).toContain("pg_catalog.to_regclass('arena.sources')")
    expect(preflight).toContain("pg_catalog.to_regclass('arena.leaderboard_capture_contracts')")
    expect(preflight).toContain("pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts')")
    expect(preflight).toContain("pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes')")
    expect(preflight).toContain("pg_catalog.to_regclass('arena.raw_objects')")
    expect(preflight).toContain("'bitget_bots_futures'::text")
    expect(preflight).toContain("'bitget_bots_spot'::text")
    expect(preflight).toContain(`'["futures_grid", "futures_martingale"]'::jsonb`)
    expect(preflight).toContain(`'["spot_grid", "spot_martingale"]'::jsonb`)
    expect(preflight).toContain("source_row.trader_kind_scope = 'bot'")
    expect(preflight).toContain('source_row.timeframes_native = ARRAY[30]::integer[]')
    expect(preflight).toContain('source_row.page_size = 20')
    expect(preflight).toContain("source_row.pagination_kind = 'numeric'")
    expect(preflight).toContain('v_exact_sources <> 2')
    expect(preflight).toContain('requires exactly two canonical active Bitget bot sources')
    expect(preflight).toContain('registry must be empty before installation')
  })

  it('widens only the acquisition constraints and registers exactly two V4 sources', () => {
    expect(migration).toMatch(
      /leaderboard_capture_contracts_capture_contract_check[\s\S]*capture_contract IN \([\s\S]*manifest@2[\s\S]*manifest@3[\s\S]*manifest@4/
    )
    expect(migration).toMatch(
      /leaderboard_acquisition_attempts_capture_contract_check[\s\S]*capture_contract IN \([\s\S]*manifest@2[\s\S]*manifest@3[\s\S]*manifest@4[\s\S]*legacy_unverified/
    )

    expect(registration).toContain('INSERT INTO arena.leaderboard_capture_contracts')
    expect(registration).toContain("'arena.ingest.leaderboard-acquisition-manifest@4'")
    expect(registration).toContain("'arena.ingest.leaderboard-acquisition-attempt-binding@1'")
    expect(registration).toContain("'bitget_bots_futures'")
    expect(registration).toContain("'bitget_bots_spot'")
    expect(registration).toContain("source_row.adapter_slug = 'bitget_bots'")
    expect(registration).toContain('requires_runner_git_sha')
    expect(registration).toContain('IF v_inserted <> 2 THEN')
    expect(migration).not.toMatch(/(?:UPDATE|DELETE FROM) arena\.leaderboard_capture_contracts/)
  })

  it('rewrites only hash-pinned V3 RPC allowlists and verifies the resulting bodies', () => {
    const preflightIndex = migration.indexOf('DO $preflight$')
    const constraintIndex = migration.indexOf('ALTER TABLE arena.leaderboard_capture_contracts')
    expect(preflightIndex).toBeGreaterThanOrEqual(0)
    expect(preflightIndex).toBeLessThan(constraintIndex)

    expect(preflight).toContain(
      "'91450023404a8adecb9949dc4179260415c667ac62f139e82936106ec2ab9a76'"
    )
    expect(preflight).toContain(
      "'ac654d08b64da69df71537b5f796fc3310e359d23815c14a5b651e29fa3e7bc4'"
    )
    expect(rewrite).toContain('pg_catalog.pg_get_functiondef')
    expect(rewrite).toContain('v_start_occurrences <> 1')
    expect(rewrite).toContain('v_finish_occurrences <> 3')
    expect(rewrite.match(/EXECUTE pg_catalog\.replace/g)).toHaveLength(2)
    expect(rewrite).not.toMatch(/CREATE OR REPLACE FUNCTION/)
    expect(postflight).toContain(
      "'3fe0c7fb170dfd43022f07736012f84cd5083a8e79e038e037efae2b6462cdcd'"
    )
    expect(postflight).toContain(
      "'3b40b3f8c79a7187edfe42e9f419e79a4d445625d6e6a9c13926470897eb35cb'"
    )
    expect(postflight).toContain("function_row.proowner = 'postgres'::pg_catalog.regrole")
    expect(postflight).toContain('function_row.prosecdef')
    expect(postflight).toContain("language_row.lanname = 'plpgsql'")
  })

  it('keeps V4 evidence-only, preserves service-only RPC ACLs, and avoids rank surfaces', () => {
    expect(migration).not.toMatch(/\barena\.metric_trust_(?:runs|observations|artifacts)\b/)
    expect(migration).not.toMatch(/\b(?:leaderboard_ranks|trader_metrics|score_inputs)\b/)
    expect(migration).not.toMatch(/\b(?:app|components|pages)\//)

    for (const rpc of [
      'arena.start_leaderboard_acquisition_attempt',
      'arena.finish_leaderboard_acquisition_attempt',
    ]) {
      expect(migration).toContain(`ALTER FUNCTION ${rpc}(`)
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${rpc}(`)
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${rpc}(`)
    }
    expect(migration).toContain(') OWNER TO postgres;')
    expect(postflight.match(/'service_role'/g)).toHaveLength(2)
    expect(postflight.match(/'anon'/g)).toHaveLength(2)
    expect(postflight.match(/'authenticated'/g)).toHaveLength(2)
    expect(migration).toContain('never grants metric trust')
  })
})
