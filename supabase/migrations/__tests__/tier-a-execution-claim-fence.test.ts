import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729015500_tier_a_execution_claim_fence.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const launchRunner = readFileSync(
  resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/tier-a-execution-claim-fence.pg17.sh'),
  'utf8'
)

describe('Tier-A execution claim fence substrate', () => {
  it('is one transactional expand-only migration at the collision-free timestamp', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|FUNCTION|VIEW|COLUMN)\b/i)
    expect(migration.match(/^CREATE TABLE IF NOT EXISTS/gm)).toHaveLength(4)
    expect(launchRunner).toContain(migrationName)
    expect(launchRunner).not.toContain('20260729015000_tier_a_execution_claim_fence.sql')
  })

  it('keeps the legacy start and finish callables intact while adding claimed overloads', () => {
    expect(migration).toContain('old_start_oid oid NOT NULL')
    expect(migration).toContain('old_start_source text NOT NULL')
    expect(migration).toContain('old_start_acl aclitem[]')
    expect(migration).toContain('old_finish_oid oid NOT NULL')
    expect(migration).toContain('old_finish_source text NOT NULL')
    expect(migration).toContain('old_finish_acl aclitem[]')
    expect(migration).toContain('legacy acquisition RPC identity, body, or ACL drifted')
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION arena\.start_leaderboard_acquisition_attempt\([\s\S]*?p_worker_region text\s*\)\s*RETURNS/
    )
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION arena\.finish_leaderboard_acquisition_attempt\([\s\S]*?p_reason_code text\s*\)\s*RETURNS/
    )
    expect(migration).toMatch(
      /p_worker_region text,\s*p_execution_claim_id uuid,\s*p_execution_generation_seq bigint/
    )
    expect(migration).toMatch(
      /p_reason_code text,\s*p_execution_claim_id uuid,\s*p_execution_generation_seq bigint/
    )
  })

  it('freezes the full Bull, source-lease, and DB-region authority proof', () => {
    for (const marker of [
      "'arena.ingest.tier-a-execution@1'",
      "'arena.ingest.bull-job-provenance@1'",
      "'arena.ingest.source-job-lease-provenance@1'",
      "queue_job_name = 'tiera:leaderboard'",
      "source_lease_lane = 'tier-a'",
      'source_lease_scope_id',
      'bull_lock_token_sha256',
      'source_lease_token_sha256',
      'authority_epoch',
      'worker_instance_id',
      'control_epoch',
      'release_id',
      'git_sha',
    ]) {
      expect(migration).toContain(marker)
    }
    expect(migration).toContain('v_source.slug')
    expect(migration).toContain('v_guard := arena.require_current_tier_a_worker_guard')
    expect(migration).toContain('pg_catalog.pg_current_xact_id()::text')
    expect(migration).toContain('current transaction lacks live Tier-A worker authority')
  })

  it('linearizes source ownership and keeps generations monotonic without abandonment', () => {
    expect(migration).toContain("'arena.tier-a-execution-source:' || p_source_id::text")
    expect(migration).toContain('v_next_generation := v_head.generation_seq + 1')
    expect(migration).toContain("USING ERRCODE = '55P03'")
    expect(migration).toContain('Tier-A claim replay is expired, closed, or superseded')
    expect(migration).toContain('Tier-A execution heartbeat was fenced')
    expect(migration).not.toMatch(
      /INSERT INTO arena\.leaderboard_acquisition_outcomes[\s\S]*?'abandoned'/
    )
  })

  it('requires a current-xid write assertion and a deferred COMMIT recheck', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS arena.tier_a_execution_write_guards')
    expect(migration).toContain('arena.assert_tier_a_execution_write(')
    expect(migration).toContain('arena.assert_tier_a_execution_fence_at_commit()')
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER tier_a_execution_fence_commit_assertion[\s\S]*?DEFERRABLE INITIALLY DEFERRED/
    )
    expect(migration).toContain("head.phase = 'active'")
    expect(migration).toContain('head.lease_expires_at > v_now')
    expect(migration).toContain('Tier-A execution was fenced before COMMIT')
    expect(migration).toContain('Tier-A execution guard cleanup was not exact')
  })

  it('makes DB receipts the exact queue/source/window skip authority', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS arena.tier_a_execution_window_receipts')
    expect(migration).toMatch(
      /PRIMARY KEY \(\s*source_id, queue_name, queue_job_id, observation_cycle_id, timeframe\s*\)/
    )
    expect(migration).toContain("contract = 'arena.ingest.tier-a-execution-window-receipt@1'")
    expect(migration).toContain('arena.record_tier_a_execution_window_receipt(')
    expect(migration).toContain('arena.get_tier_a_execution_window_receipt(')
    expect(migration).toContain('p_queue_name text')
    expect(migration).toContain('p_observation_cycle_id text')
    expect(migration).toContain('observation_cycle_id text NOT NULL')
    expect(migration).toContain('receipt.observation_cycle_id = p_observation_cycle_id')
    expect(migration).toContain("v_outcome.terminal_state IS DISTINCT FROM 'complete'")
    expect(migration).toContain('v_snapshot.count_check_passed IS DISTINCT FROM true')
    expect(migration).toContain('v_snapshot.is_derived IS DISTINCT FROM false')
    expect(migration).toMatch(
      /v_snapshot\.raw_object_id IS DISTINCT FROM\s+v_outcome\.source_payload_raw_object_id/
    )
    expect(migration).toContain('Redis hints alone never authorize skipping')
    expect(migration).not.toContain('BETWEEN 1 AND 1024')
  })

  it('keeps legacy finish compatible only for historically unclaimed attempts', () => {
    expect(migration).toMatch(
      /attempt\.execution_claim_id IS NULL\s+AND attempt\.execution_generation_seq IS NULL/
    )
    expect(migration).toContain('claimed acquisition attempt requires claimed finish RPC')
    expect(migration).toContain("USING ERRCODE = '42501'")
  })

  it('closes every private table and exposes only service-role RPCs', () => {
    for (const table of [
      'tier_a_execution_claims',
      'tier_a_execution_heads',
      'tier_a_execution_write_guards',
      'tier_a_execution_window_receipts',
    ]) {
      expect(migration).toContain(`ALTER TABLE arena.${table} ENABLE ROW LEVEL SECURITY`)
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE arena\\.${table}\\s+FROM PUBLIC, anon, authenticated, service_role;`
        )
      )
    }
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.claim_tier_a_execution\([\s\S]*?\) TO service_role;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION arena\.get_tier_a_execution_window_receipt\([\s\S]*?\) TO service_role;/
    )
  })

  it('ships a PostgreSQL 17 proof for compatibility, ACLs, leases, and receipts', () => {
    for (const marker of [
      'legacy start callable changed across install or replay',
      'legacy finish callable changed across install or replay',
      'legacy fresh start stopped working',
      'service role claimed without a region guard',
      'claim response-loss replay was not frozen',
      'competing active source claim was accepted',
      'expired generation did not permit takeover',
      'region authority replacement did not permit monotonic takeover',
      'stale generation heartbeat revived a claim',
      'claimed start did not bind the attempt',
      'stale generation finalized after takeover',
      'receipt getter ignored queue name',
      'receipt getter ignored observation cycle',
      'different observation cycles could not retain independent receipts',
      'receipt accepted incomplete publication evidence',
      'receipt table was mutable',
      'execution write guard survived COMMIT',
      'migration replay retained a rogue execution-function grant',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
