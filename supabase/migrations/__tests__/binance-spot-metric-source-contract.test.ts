import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260722053000_binance_spot_metric_source_contract.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/binance-spot-metric-source-contract.pg17.sh'),
  'utf8'
)

describe('Binance Spot metric source contract', () => {
  it('is an atomic append-only PREDEPLOY registration, not a serving cutover', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'")
    expect(migration).toContain(
      'LOCK TABLE arena.metric_source_contracts IN SHARE ROW EXCLUSIVE MODE'
    )
    expect(migration).toContain("v_source.serving_mode = 'serving'")
    expect(migration).toContain('must be non-serving and non-dropped')
    expect(migration).not.toMatch(/(?:UPDATE|DELETE)\s+(?:FROM\s+)?arena\.sources/i)
    expect(migration).not.toMatch(/(?:UPDATE|DELETE)\s+(?:FROM\s+)?arena\.metric_source_contracts/i)
    expect(migration).not.toMatch(/leaderboard_ranks|CREATE OR REPLACE VIEW arena\.score_inputs/)
    expect(migration).not.toContain('ON CONFLICT')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(runner).toContain(migrationName)
  })

  it('pins the reviewed Spot source identity before registering fields', () => {
    for (const token of [
      "v_source.adapter_slug IS DISTINCT FROM 'binance'",
      "v_exchange_slug IS DISTINCT FROM 'binance'",
      "v_source.product_type IS DISTINCT FROM 'spot'",
      "v_source.currency IS DISTINCT FROM 'USDT'",
      'v_source.page_size IS DISTINCT FROM 20',
      "v_source.pagination_kind IS DISTINCT FROM 'numeric'",
      "v_source.fetch_region IS DISTINCT FROM 'vps_sg'",
      'ARRAY[7, 30, 90]::integer[]',
      "v_source.meta->>'boardKey' IS DISTINCT FROM 'spot'",
      "v_source.meta->'click_all_portfolios' IS DISTINCT FROM 'true'::jsonb",
      "v_source.meta->'position_history_dual_sort' IS DISTINCT FROM 'true'::jsonb",
    ]) {
      expect(migration).toContain(token)
    }
    expect(migration).toContain('metric_source_contracts_reject_direct_mutation')
    expect(migration).toContain('metric_source_contracts_reject_truncate')
    expect(migration).toContain('trigger_row.tgfoid = v_reject_oid')
    expect(migration).toContain('trigger_row.tgqual IS NULL')
    expect(migration).toContain('pg_catalog.pg_get_functiondef(function_row.oid)')
    expect(migration).toContain("'8f33c3e101839453d73bcb99156e4f2a'")
    expect(migration).toMatch(
      /FROM pg_catalog\.pg_trigger AS trigger_row[\s\S]*NOT trigger_row\.tgisinternal[\s\S]*\) <> 2/
    )
    expect(migration).toContain('relrowsecurity')
    expect(migration).toContain("'service_role', 'arena.metric_source_contracts', 'TRUNCATE'")
    expect(migration).toContain('privilege_row.grantee NOT IN (v_registry_owner, v_service_role)')
    expect(migration).toContain('FROM pg_catalog.pg_policy AS policy_row')
    expect(migration).toContain('foreign-key or uniqueness boundary drifted')
  })

  it('registers only upstream population ROI and PnL without granting trust', () => {
    expect(migration).toContain("'data.list[].roi'::text")
    expect(migration).toContain("'data.list[].pnl'")
    expect(migration).not.toContain('performance.roi')
    expect(migration).not.toContain('performance.pnl')
    expect(migration).toContain("'source_reported'::text")
    expect(migration).toContain("'binance-board-roi-pnl@1'")
    expect(migration).toContain("ARRAY['source_payload', 'population_manifest']::text[]")
    expect(migration).toContain("'population_snapshot'::text")
    expect(migration).toContain('false,')
    expect(migration).toContain('expected exactly two Binance Spot population contracts')
    expect(migration).toContain('EXCEPT ALL')
    expect(migration).toContain('v_total <> 2 OR v_drift')
    expect(migration).toContain('do not prove population,')
    expect(migration).toContain(
      'window, quality, price, cost basis, freshness, or rank eligibility'
    )
  })

  it('ships a PostgreSQL 17 proof for happy, replay, drift, and serving cases', () => {
    expect(pg17).toContain('Binance Spot metric source contract PostgreSQL 17 proof passed')
    expect(pg17).toContain('echo "$label unexpectedly succeeded"')
    expect(pg17).toContain("expect_migration_failure replay 'already has metric source contracts'")
    expect(pg17).toContain("expect_migration_failure 'source drift' 'source registry drifted'")
    expect(pg17).toContain(
      "expect_migration_failure 'serving source' 'must be non-serving and non-dropped'"
    )
    expect(pg17).toContain(
      "expect_migration_failure 'preexisting contract' 'already has metric source contracts'"
    )
    for (const label of [
      'no-op trigger',
      'no-op reject function',
      'conditional reject trigger',
      'extra registry trigger',
      'foreign-key drift',
      'unique drift',
      'disabled RLS',
      'PUBLIC ACL leak',
      'third-role ACL leak',
      'policy-only leak',
      'anonymous insert policy',
    ]) {
      expect(pg17).toContain(`expect_migration_failure '${label}'`)
    }
    expect(pg17).toContain('Binance Spot full contract semantics drifted')
    expect(pg17).toContain("'binance-board-roi@1'::text")
    expect(pg17).toContain("'binance-board-pnl@1'::text")
    expect(pg17).toContain('ARRAY[7, 30, 90]::smallint[]')
    expect(pg17).toContain("ARRAY['source_payload', 'population_manifest']::text[]")
    expect(pg17).toContain('successful registration changed source serving state')
  })
})
