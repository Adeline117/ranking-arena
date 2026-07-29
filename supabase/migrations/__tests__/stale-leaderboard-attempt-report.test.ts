import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729060000_stale_leaderboard_attempt_report.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const launchRunner = readFileSync(
  resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)
const cli = readFileSync(resolve(root, 'scripts/report-stale-leaderboard-attempts.mts'), 'utf8')
const cliLibrary = readFileSync(
  resolve(root, 'scripts/lib/stale-leaderboard-attempt-report.ts'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/stale-leaderboard-attempt-report.pg17.sh'),
  'utf8'
)

describe('stale leaderboard acquisition attempt report', () => {
  it('is a collision-free transactional PREDEPLOY migration', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).not.toContain('CREATE INDEX')
    expect(launchRunner).toMatch(
      /20260729054400_leaderboard_rank_generation_private_staging\.sql\s+20260729060000_stale_leaderboard_attempt_report\.sql/
    )
    expect(launchRunner).toMatch(
      /POSTDEPLOY_MIGRATIONS=\([\s\S]*20260729061000_tier_a_execution_claim_enforcement\.sql[\s\S]*?\)/
    )
  })

  it('exposes one stable SECURITY DEFINER report only to service_role', () => {
    expect(migration).toMatch(
      /CREATE FUNCTION arena\.report_stale_leaderboard_acquisition_attempts\(\s*p_request jsonb\s*\)[\s\S]*?STABLE[\s\S]*?PARALLEL RESTRICTED[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, pg_temp[\s\S]*?SET statement_timeout = '15s'/
    )
    expect(migration).toContain('DO $close_acl$')
    expect(migration).toContain('CROSS JOIN LATERAL pg_catalog.aclexplode(')
    expect(migration).toContain('acl_row.grantee <> v_owner')
    expect(migration).toContain('FROM %I')
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION\s+arena\.report_stale_leaderboard_acquisition_attempts\(jsonb\)\s+TO service_role;/
    )
    expect(migration).toContain('acl_row.grantee NOT IN (')
    expect(migration).toContain('acl_row.is_grantable')
    expect(migration).toContain("'statement_timeout=15s'")
    expect(migration).toContain("pg_catalog.has_function_privilege('anon', v_report, 'EXECUTE')")
    expect(migration).toContain("'authenticated', v_report, 'EXECUTE'")
  })

  it('requires an exact bounded request and freezes observed-at plus high-water', () => {
    for (const marker of [
      "'arena.ingest.stale-leaderboard-attempt-report-request@1'",
      "'arena.ingest.stale-leaderboard-attempt-report-response@1'",
      'pg_catalog.jsonb_object_keys(p_request)',
      'v_page_size NOT BETWEEN 1 AND 1000',
      'v_stale_after_seconds NOT BETWEEN 300 AND 2592000',
      "pg_catalog.transaction_timestamp() - interval '5 minutes'",
      "pg_catalog.transaction_timestamp() + interval '5 minutes'",
      'v_high_water > v_current_high_water',
      'v_after > v_high_water',
      'attempt.attempt_seq > v_after',
      'attempt.attempt_seq <= v_high_water',
      'ORDER BY attempt.attempt_seq',
      'LIMIT v_page_size + 1',
    ]) {
      expect(migration).toContain(marker)
    }
    expect(migration).toContain("'high_water_attempt_seq', v_high_water::text")
    expect(migration).toContain("'next_after_attempt_seq'")
  })

  it('reports only expired open attempts and classifies every authority state', () => {
    expect(migration).toMatch(
      /LEFT JOIN arena\.leaderboard_acquisition_outcomes[\s\S]*?outcome\.attempt_seq IS NULL/
    )
    expect(migration).toMatch(
      /attempt\.recorded_started_at <=\s*v_observed_at -\s*pg_catalog\.make_interval/
    )
    for (const marker of [
      "'ownership'",
      "'claimed'",
      "'legacy'",
      "'attempt_position'",
      "'current'",
      "'superseded'",
      "'age_state', 'expired'",
      "'attempt_phase', 'open'",
      "'authority_state'",
      "'legacy_unfenced'",
      "'fenced'",
      "'closed'",
      "'execution_phase'",
    ]) {
      expect(migration).toContain(marker)
    }
  })

  it('cannot mutate attempt state and does not return authority or evidence secrets', () => {
    expect(migration).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+arena\.(?:leaderboard_acquisition|tier_a_execution)/i
    )
    expect(migration).not.toMatch(/arena\.(?:start|finish)_leaderboard_acquisition_attempt\s*\(/i)
    expect(migration).not.toMatch(/arena\.close_tier_a_execution\s*\(/i)

    for (const forbiddenOutputKey of [
      'bull_lock_token_sha256',
      'source_lease_id',
      'source_lease_token_sha256',
      'execution_claim_id',
      'worker_instance_id',
      'worker_node_id',
      'worker_region',
      'release_id',
      'git_sha',
      'source_run_id',
      'raw_object_id',
      'storage_path',
      'content_hash',
    ]) {
      expect(migration).not.toContain(`'${forbiddenOutputKey}',`)
    }
  })

  it('ships a CLI that validates exact output and always rolls back a read-only snapshot', () => {
    expect(cliLibrary).toContain(
      "client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')"
    )
    expect(cliLibrary).toContain("client.query('SET LOCAL ROLE service_role')")
    expect(cliLibrary).toContain('client.query("SET LOCAL statement_timeout = \'15s\'")')
    expect(cliLibrary).toContain('client.query("SET LOCAL lock_timeout = \'3s\'")')
    expect(cliLibrary).toContain("await client.query('ROLLBACK')")
    expect(cliLibrary).not.toContain("client.query('COMMIT')")
    expect(cliLibrary).toContain('hasExactKeys(payload, RESPONSE_KEYS)')
    expect(cliLibrary).toContain('hasExactKeys(value, ROW_KEYS)')
    expect(cliLibrary).toContain('mutation_authorized: false')
    expect(cliLibrary).toContain('MAX_STALE_ATTEMPT_REPORT_ROWS = 10_000')
    expect(cliLibrary).toContain('MAX_STALE_ATTEMPT_REPORT_PAGES = 1_000')
    expect(cliLibrary).toContain('LOCAL_DATABASE_HOSTNAMES.has(parsed.hostname)')
    expect(cliLibrary).toContain('ssl: isLocal ? false : { rejectUnauthorized: true }')
    expect(cliLibrary).toContain('connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS')
    expect(cliLibrary).toContain('query_timeout: DATABASE_QUERY_TIMEOUT_MILLIS')
    expect(cliLibrary).toContain('keepAlive: true')
    expect(cli).toContain('buildStaleAttemptDatabaseClientConfig(connectionString)')
    expect(cli).not.toContain("connectionString.includes('localhost')")
    expect(cli).not.toContain('rejectUnauthorized: false')
    expect(cli).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i)
  })

  it('ships a PostgreSQL 17 proof for ACL, pagination, classification, and immutability', () => {
    for (const marker of [
      'report ACLs are not service-role-only',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres',
      'first page did not freeze the exact high-water and keyset cursor',
      'legacy current/superseded classification drifted',
      'claimed fenced and expired classifications drifted',
      'claimed closed and current classifications drifted',
      'closed or fresh attempts leaked into the stale report',
      'report response exposed an authority or evidence secret key',
      'fixed high-water admitted a later attempt',
      'report mutated an acquisition outcome or execution head',
      'overflowing high-water',
      'historical observed-at',
      'future observed-at',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
