import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260804054200_harden_copier_snapshot_receipt_provenance.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/harden-copier-snapshot-receipt-provenance.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8')
const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
const runbook = readFileSync(resolve(root, 'docs/RUNBOOK.md'), 'utf8')

function functionBody(sql: string, signature: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const bodyStart = sql.indexOf('AS $function$', start)
  expect(bodyStart).toBeGreaterThan(start)
  const end = sql.indexOf('$function$;', bodyStart + 13)
  expect(end).toBeGreaterThan(bodyStart)
  return sql.slice(bodyStart, end)
}

function runnerArray(name: string): string {
  const start = runner.indexOf(`${name}=(`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = runner.indexOf('\n)', start)
  expect(end).toBeGreaterThan(start)
  return runner.slice(start, end)
}

describe('copier snapshot receipt provenance hardening', () => {
  const guard = functionBody(migration, 'arena.guard_copier_snapshot_publication_insert_v1')
  const normalizer = functionBody(migration, 'arena.normalize_copier_snapshot_row_source_event_v1')

  it('is a locked PG17 transaction that refuses any installed receipt or row', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain("current_user IS DISTINCT FROM 'postgres'")
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(migration).toContain(
      'LOCK TABLE ONLY arena.copier_snapshot_publications IN ACCESS EXCLUSIVE MODE'
    )
    expect(migration).toContain(
      'LOCK TABLE ONLY arena.copier_snapshot_rows IN ACCESS EXCLUSIVE MODE'
    )
    expect(migration).toContain('SELECT 1 FROM arena.copier_snapshot_publications LIMIT 1')
    expect(migration).toContain('SELECT 1 FROM arena.copier_snapshot_rows LIMIT 1')
    expect(migration).toContain('requires zero existing receipts and rows')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('makes unproven V1 row event provenance nullable and always stores NULL', () => {
    expect(migration).toContain('ALTER COLUMN source_event_at DROP NOT NULL')
    expect(migration).toContain(
      'V1 copier receipts do not prove an upstream source-event timestamp.'
    )
    expect(normalizer).toContain('NEW.source_event_at := NULL')
    expect(normalizer).not.toContain('statement_timestamp')
    expect(migration).toContain(
      'CREATE TRIGGER copier_snapshot_row_normalize_source_event_v1\nBEFORE INSERT'
    )
  })

  it('locks the exact subject at final insert and rejects future, claimed, or demoted subjects', () => {
    expect(guard).toContain(
      "NEW.observed_at >\n        pg_catalog.statement_timestamp() + interval '5 minutes'"
    )
    expect(guard).toContain('trader_row.source_id = source_row.id')
    expect(guard).toContain('source_row.id = NEW.source_id')
    expect(guard).toContain('trader_row.id = NEW.trader_id')
    expect(guard).toContain('FOR SHARE OF source_row, trader_row')
    expect(guard).toContain("v_status IS DISTINCT FROM 'active'")
    expect(guard).toContain("v_serving_mode IS DISTINCT FROM 'serving'")
    expect(guard).toContain("v_trader_meta->>'claimed' = 'true'")
    expect(guard).toContain('claimed trader copier snapshots cannot be published')
    expect(migration).toContain(
      'CREATE TRIGGER copier_snapshot_publication_guard_insert_v1\nBEFORE INSERT'
    )
  })

  it('normalizes every unsafe histogram instead of exposing a sub-ten PnL cohort', () => {
    expect(guard).toContain('v_allowed_buckets constant text[]')
    expect(guard).toContain('v_expected_bucket_keys constant text[]')
    expect(guard).toContain('jsonb_object_keys(v_bucket)')
    expect(guard).toContain('v_bucket_index <= v_previous_bucket_index')
    expect(guard).toContain('v_bucket_count < 5')
    expect(guard).toContain('v_distribution_total < 10')
    expect(guard).toContain('v_distribution_total > NEW.copier_count')
    expect(guard).toContain("NEW.pnl_distribution := '[]'::pg_catalog.jsonb")
  })

  it('retains invoker security, fixed search paths, private ACLs, and immutable triggers', () => {
    expect(migration.match(/SECURITY INVOKER/g)).toHaveLength(2)
    expect(migration.match(/SET search_path = pg_catalog, pg_temp/g).length).toBeGreaterThanOrEqual(
      2
    )
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION arena.guard_copier_snapshot_publication_insert_v1()'
    )
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION arena.normalize_copier_snapshot_row_source_event_v1()'
    )
    expect(migration).toContain('copier_snapshot_publication_reject_update_delete')
    expect(migration).toContain('copier_snapshot_row_reject_update_delete')
    expect(migration).toContain('copier snapshot provenance trigger postflight failed')
  })

  it('proves replay, concurrency, provenance, lifecycle, clock, and histogram privacy on PG17', () => {
    for (const marker of [
      'empty hardening replay drifted',
      'drifted hardening replay repaired ACL instead of failing closed',
      'future database observation clock was accepted',
      'claimed trader receipt was accepted',
      'inactive source receipt was accepted',
      'demoted source receipt was accepted',
      'wrong source/trader subject was accepted',
      'publisher acquisition clock survived as source-event provenance',
      'five-person PnL cohort escaped the public aggregate',
      'ten-person PnL cohort was suppressed',
      'all-null PnL receipt exposed a distribution',
      'claim-first publication did not wait for the claim lock',
      'claim-first publication escaped claimed rejection',
      'publication-first claim did not wait for the publication lock',
      'concurrent exact replay returned different receipts',
      'data-bearing hardening replay did not fail closed',
      'copier snapshot receipt provenance 054200 PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })

  it('is wired exactly between 054000 and 054500 while 055000 stays manual-only', () => {
    const authority = '20260804054000_copier_snapshot_publication_authority.sql'
    const laneAuthority = '20260804054300_copier_snapshot_lane_v2_authority.sql'
    const correction = '20260804054500_correct_okx_copier_depth_contract.sql'
    const cutover = '20260804055000_copier_snapshot_direct_write_cutover.sql'
    const predeploy = runnerArray('PREDEPLOY_MIGRATIONS')

    expect(predeploy).toContain(
      `${authority}\n  ${migrationName}\n  ${laneAuthority}\n  ${correction}`
    )
    for (const phase of [
      'PREDEPLOY_MIGRATIONS',
      'POSTDEPLOY_MIGRATIONS',
      'RECOVERY_PREREQUISITE_MIGRATIONS',
      'CONCURRENT_RECOVERY_MIGRATIONS',
      'RECOVERY_MIGRATIONS',
      'QUARANTINED_PREDEPLOY_MIGRATIONS',
      'SUPERSEDED_MIGRATIONS',
    ]) {
      expect(runnerArray(phase)).not.toContain(cutover)
    }
    expect(packageJson).toContain('qa:copier-snapshot-provenance-pg17')
    expect(ci).toContain('npm run qa:copier-snapshot-provenance-pg17')
    expect(runbook).toContain('以下二十四个 2026-08 migration')
    expect(runbook).toContain(migrationName)
  })
})
