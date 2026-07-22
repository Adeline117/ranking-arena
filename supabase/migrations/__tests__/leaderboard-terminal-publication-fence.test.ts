import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260722042000_leaderboard_terminal_publication_fence.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/leaderboard-terminal-publication-fence.pg17.sh'),
  'utf8'
)

function migrationNames(arrayName: string): string[] {
  const marker = new RegExp(`^${arrayName}=\\(\\n`, 'm')
  const match = marker.exec(runner)
  expect(match).not.toBeNull()
  const bodyStart = (match?.index ?? 0) + (match?.[0].length ?? 0)
  const bodyEnd = runner.indexOf('\n)', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return [...runner.slice(bodyStart, bodyEnd).matchAll(/^\s+(202\d{11}_[a-z0-9_]+\.sql)$/gm)].map(
    (entry) => entry[1]
  )
}

describe('leaderboard terminal publication fence migration', () => {
  it('adds only an atomic private terminal serializer', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain(
      'CREATE FUNCTION arena.serialize_leaderboard_terminal_publication()'
    )
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?arena\./i)
    expect(migration).not.toMatch(/CREATE OR REPLACE/)
    expect(migration).not.toMatch(/\b(?:leaderboard_ranks|metric_trust_runs|trader_metrics)\b/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('derives the lock identity from the immutable parent attempt', () => {
    const selectParent = migration.indexOf('FROM arena.leaderboard_acquisition_attempts AS attempt')
    const lock = migration.indexOf('PERFORM pg_catalog.pg_advisory_xact_lock(', selectParent)
    expect(selectParent).toBeGreaterThanOrEqual(0)
    expect(lock).toBeGreaterThan(selectParent)
    expect(migration).toContain('WHERE attempt.attempt_seq = NEW.attempt_seq')
    expect(migration).toContain("'arena.leaderboard-acquisition-source:'")
    expect(migration).toContain("v_source_id::text || ':' || v_timeframe::text")
    expect(migration).not.toContain('NEW.source_id')
    expect(migration).not.toContain('NEW.timeframe')
    expect(migration).toContain("USING ERRCODE = '23503'")
  })

  it('runs the reject-direct trigger before the authorized insert serializer', () => {
    const reject = 'leaderboard_acquisition_outcomes_reject_direct_row_mutation'
    const serializer = 'leaderboard_acquisition_outcomes_serialize_terminal_publication'
    expect(reject.localeCompare(serializer)).toBeLessThan(0)
    expect(migration).toContain(`${reject}'\n          AND NOT trigger_row.tgisinternal`)
    expect(migration).toContain('AND trigger_row.tgtype = 31')
    expect(migration).toContain(`CREATE TRIGGER ${serializer}`)
    expect(migration).toContain(
      'BEFORE INSERT ON arena.leaderboard_acquisition_outcomes\nFOR EACH ROW'
    )
    expect(migration).toContain('reject_trigger.tgname < serialize_trigger.tgname')
  })

  it('pins postgres ownership, trigger shape, and owner-only ACL in postflight', () => {
    expect(migration).toContain(
      'ALTER FUNCTION arena.serialize_leaderboard_terminal_publication()\n  OWNER TO postgres;'
    )
    expect(migration).toMatch(
      /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain('trigger_row.tgtype = 7')
    expect(migration).toContain("trigger_row.tgenabled = 'O'")
    expect(migration).toContain('function_row.proowner = v_postgres')
    expect(migration).toContain('function_row.prosecdef')
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain('privilege_row.grantee <> function_row.proowner')
    expect(migration).toMatch(
      /REVOKE ALL[\s\S]*ON FUNCTION arena\.serialize_leaderboard_terminal_publication\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role;/
    )
  })

  it('is ordered after the attempt, v3 compatibility, and scorer in ordered predeploy', () => {
    const predeploy = migrationNames('PREDEPLOY_MIGRATIONS')
    const recoveryPrerequisites = migrationNames('RECOVERY_PREREQUISITE_MIGRATIONS')
    const postdeploy = migrationNames('POSTDEPLOY_MIGRATIONS')
    const index = predeploy.indexOf(migrationName)

    expect(index).toBeGreaterThan(
      predeploy.indexOf('20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql')
    )
    expect(index).toBeGreaterThan(
      predeploy.indexOf('20260722040000_leaderboard_acquisition_manifest_v3_compat.sql')
    )
    expect(index).toBeGreaterThan(
      predeploy.indexOf('20260722041000_pure_arena_score_v4_scorer.sql')
    )
    expect(recoveryPrerequisites).not.toContain(migrationName)
    expect(postdeploy).not.toContain(migrationName)
    expect(runner.match(new RegExp(migrationName.replace('.', '\\.'), 'g'))).toHaveLength(1)
    expect(runner).toContain('prepare_ordered_predeploy_target')
  })

  it('contains PostgreSQL 17 proofs for the three real concurrency orders', () => {
    for (const marker of [
      'finish did not wait on the publisher advisory lock',
      'publisher did not wait behind the uncommitted terminal',
      'publisher did not observe the already-committed terminal',
      'concurrent in-progress finishes deadlocked or failed',
      "wait_event = 'advisory'",
      'leaderboard_acquisition_outcomes_reject_direct_row_mutation',
      'leaderboard_acquisition_outcomes_serialize_terminal_publication',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
