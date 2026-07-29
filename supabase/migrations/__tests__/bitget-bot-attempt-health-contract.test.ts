import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729013000_bitget_bot_attempt_health_contract.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/bitget-bot-attempt-health-contract.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

const functionBody = migration.slice(
  migration.indexOf('CREATE FUNCTION public.arena_bitget_bot_acquisition_attempt_health()'),
  migration.indexOf(
    'ALTER FUNCTION public.arena_bitget_bot_acquisition_attempt_health()',
    migration.indexOf('CREATE FUNCTION public.arena_bitget_bot_acquisition_attempt_health()')
  )
)
const latestAttemptJoin = functionBody.slice(
  functionBody.indexOf('LEFT JOIN arena.latest_leaderboard_acquisition_attempts AS attempt'),
  functionBody.indexOf('LEFT JOIN LATERAL (')
)

describe('Bitget bot attempt-health database contract', () => {
  it('is one additive, atomic service-only read contract after V4', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(
      migrationName.localeCompare('20260729012000_partitioned_bot_acquisition_manifest_v4.sql')
    ).toBeGreaterThan(0)
    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    )
    expect(
      predeploy.indexOf('20260729012000_partitioned_bot_acquisition_manifest_v4.sql')
    ).toBeLessThan(predeploy.indexOf(migrationName))
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(1)

    expect(migration).toContain(
      'CREATE FUNCTION public.arena_bitget_bot_acquisition_attempt_health()'
    )
    expect(functionBody).toMatch(/LANGUAGE sql\s+STABLE\s+SECURITY INVOKER/)
    expect(functionBody).toContain('SET search_path = pg_catalog, pg_temp')
    expect(functionBody).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i)
    expect(migration).not.toMatch(/CREATE (?:OR REPLACE )?(?:TRIGGER|TABLE|VIEW)/)
    expect(migration).not.toMatch(/ALTER TABLE arena\.leaderboard_acquisition_/)
    expect(migration).not.toContain('serialize_leaderboard_terminal_publication')
  })

  it('drives exactly two fixed 30D rows from the canonical V4 registry', () => {
    for (const marker of [
      "'bitget_bots_futures'",
      "'bitget_bots_spot'",
      "'arena.ingest.leaderboard-acquisition-manifest@4'",
      "'arena.ingest.leaderboard-acquisition-attempt-binding@1'",
      'WITH target_sources(source_slug) AS MATERIALIZED',
      'JOIN arena.leaderboard_capture_contracts AS capture',
      'FROM canonical_sources AS source_row',
      'LEFT JOIN arena.latest_leaderboard_acquisition_attempts AS attempt',
      '30::smallint AS timeframe',
      "WHEN attempt.attempt_seq IS NULL THEN 'not_started'",
      'attempt.source_slug IS DISTINCT FROM source_row.source_slug',
      'attempt.capture_contract IS DISTINCT FROM',
    ]) {
      expect(functionBody).toContain(marker)
    }
    expect(functionBody).not.toMatch(/FROM arena\.leaderboard_acquisition_attempts\b/)
    expect(latestAttemptJoin).not.toContain('attempt.source_slug = source_row.source_slug')
    expect(functionBody).not.toContain("source_row.status = 'active'")
    expect(functionBody).not.toContain("source_row.serving_mode = 'serving'")
    expect(migration).toContain("source_row.adapter_slug = 'bitget_bots'")
    expect(migration).toContain("source_row.trader_kind_scope = 'bot'")
    expect(migration).toContain('source_row.timeframes_native = ARRAY[30]::integer[]')
    expect(migration).toContain('source_row.timeframes_derived = ARRAY[]::integer[]')
    expect(migration).toContain('source_row.page_size = 20')
    expect(migration).toContain("source_row.pagination_kind = 'numeric'")
    expect(migration).toContain("'security_invoker=true' = ANY (v_latest_view_options)")
    expect(migration).toContain("'attempt_seq DESC'")
  })

  it('classifies every physical-attempt state at exact grace boundaries', () => {
    for (const state of [
      'not_started',
      'open_fresh',
      'open_stale_suspect',
      'partial',
      'unknown',
      'processing_failed',
      'abandoned',
      'complete_in_publication_grace',
      'complete_unpublished',
      'published_gated',
      'published',
    ]) {
      expect(functionBody).toContain(`'${state}'`)
      expect(pg17).toContain(`'${state}'`)
    }
    expect(functionBody).toContain("> pg_catalog.statement_timestamp() - interval '2 hours'")
    expect(functionBody).toContain("> pg_catalog.statement_timestamp() - interval '10 minutes'")
    expect(functionBody.indexOf("THEN 'published_gated'")).toBeLessThan(
      functionBody.indexOf("THEN 'complete_in_publication_grace'")
    )
    expect(functionBody.indexOf("THEN 'published'")).toBeLessThan(
      functionBody.indexOf("THEN 'complete_in_publication_grace'")
    )
  })

  it('recognizes publication only through exact typed V4 snapshot lineage', () => {
    for (const marker of [
      'snapshot.source_id = attempt.source_id',
      'snapshot.timeframe = attempt.timeframe',
      'snapshot.raw_object_id = attempt.source_payload_raw_object_id',
      "snapshot.meta->>'source_run_id' = attempt.source_run_id",
      "snapshot.meta->>'acquisition_contract' = attempt.capture_contract",
      "snapshot.meta->>'source_payload_raw_object_id' =",
      "snapshot.meta->>'manifest_raw_object_id' =",
      "snapshot.meta->'source_payload_raw_object_id'",
      "snapshot.meta->'manifest_raw_object_id'",
      "= 'number'",
      'AND NOT snapshot.is_derived',
      'snapshot.count_check_passed DESC',
    ]) {
      expect(functionBody).toContain(marker)
    }
    expect(pg17).toContain('Near matches independently violate source, window, run, contract')
    expect(pg17).toContain('Legacy or misbound latest attempts fail closed as unknown')
    expect(pg17).toContain("'published_gated'")
    expect(pg17).toContain("'published'")
  })

  it('pins ACL/search-path/read-only shape and carries a durable PG17 proof', () => {
    expect(migration).toMatch(
      /ALTER FUNCTION public\.arena_bitget_bot_acquisition_attempt_health\(\)\s+OWNER TO postgres;/
    )
    expect(migration).toMatch(
      /REVOKE ALL[\s\S]*arena_bitget_bot_acquisition_attempt_health\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*arena_bitget_bot_acquisition_attempt_health\(\)[\s\S]*TO service_role;/
    )
    expect(migration).toContain('AND NOT function_row.prosecdef')
    expect(migration).toContain("function_row.provolatile = 's'")
    expect(migration).toContain('function_row.proconfig = ARRAY[')
    expect(migration).toContain('pg_catalog.aclexplode(')

    for (const marker of [
      'attempt-health migration changed the terminal fence',
      'health contract did not return exactly two registry rows',
      'mutable source flags removed a fixed V4 registry row',
      'latest physical attempt did not win',
      'read-only health call mutated durable state',
      'anonymous attempt-health read',
      'authenticated attempt-health read',
      'service attempt-ledger mutation',
      'Bitget bot attempt health PG17 proof passed',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
