import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729058000_source_registry_runtime_contract.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/source-registry-runtime-contract.pg17.sh'),
  'utf8'
)

describe('source registry adapter runtime contract', () => {
  it('converges the reviewed registry rows atomically without cutting over serving state', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '45s'")
    expect(migration).toContain("'arena.sources:adapter-runtime-contract:v1'")
    expect(migration).toContain("'arena.publish-board-series:' || v_source_id::text")
    expect(migration).toContain('LOCK TABLE arena.sources IN SHARE MODE')
    expect(migration).toContain('LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain('ADD CONSTRAINT sources_active_adapter_runtime_contract')
    expect(migration).toContain('VALIDATE CONSTRAINT sources_active_adapter_runtime_contract')
    expect(migration).not.toMatch(/\bSET\s+(?:status|serving_mode)\s*=/i)
    expect(migration).not.toMatch(
      /UPDATE\s+arena\.sources[\s\S]{0,240}\b(?:status|serving_mode)\s*=/i
    )
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('pins all seven reviewed source identities before applying bounded repairs', () => {
    for (const slug of [
      'bitfinex',
      'bitmart_futures',
      'hyperliquid',
      'kucoin_futures',
      'okx_futures',
      'okx_spot',
      'toobit_futures',
    ]) {
      expect(migration).toContain(`'${slug}'`)
    }

    for (const identity of [
      "('bitfinex'::text, 'bitfinex'::text, 'bitfinex'::text, 'futures'::text, 'human'::text)",
      "('bitmart_futures', 'bitmart', 'bitmart', 'futures', 'mixed')",
      "('hyperliquid', 'hyperliquid', 'hyperliquid', 'onchain', 'human')",
      "('kucoin_futures', 'kucoin', 'kucoin', 'futures', 'mixed')",
      "('okx_futures', 'okx', 'okx', 'futures', 'human')",
      "('okx_spot', 'okx', 'okx', 'spot', 'human')",
      "('toobit_futures', 'toobit', 'toobit', 'futures', 'human')",
    ]) {
      expect(migration).toContain(identity)
    }

    expect(migration).toContain('reviewed source identity drifted; refusing broad registry repair')
    expect(migration).toContain('expected exactly seven reviewed source rows')
    expect(migration).toContain('pg_catalog.jsonb_typeof(source.meta)')
  })

  it('records native versus derived windows and adapter-specific runtime facts', () => {
    for (const contract of [
      "('bitfinex'::text, ARRAY[7, 30]::integer[], ARRAY[]::integer[])",
      "('bitmart_futures', ARRAY[7, 30]::integer[], ARRAY[90]::integer[])",
      "('hyperliquid', ARRAY[7, 30]::integer[], ARRAY[90]::integer[])",
      "('kucoin_futures', ARRAY[30]::integer[], ARRAY[7, 90]::integer[])",
      "('okx_futures', ARRAY[90]::integer[], ARRAY[7, 30]::integer[])",
      "('okx_spot', ARRAY[90]::integer[], ARRAY[7, 30]::integer[])",
      "('toobit_futures', ARRAY[7, 30, 90]::integer[], ARRAY[]::integer[])",
    ]) {
      expect(migration).toContain(contract)
    }

    for (const fact of [
      "SET currency = 'USD'",
      "fetch_region = 'vps_sg'",
      'page_size = 20',
      'page_size = 6',
      "pagination_kind = 'numeric'",
      "'derived_stats_max_age_hours', 168",
      "'inst_type'",
      "'SPOT'",
      "'SWAP'",
      'expected_count = 10000',
      'page_size = 5000',
      'rate_budget_ms = 1100',
      "cadence_tier_a = interval '6 hours'",
      'deep_profile_topn = 500',
      "'board_depth', 10000",
    ]) {
      expect(migration).toContain(fact)
    }
  })

  it('fails closed when nullable runtime fields or JSON evidence are removed', () => {
    expect(migration).toContain('OR COALESCE((')
    for (const predicate of [
      'page_size IS NOT DISTINCT FROM 20',
      "pagination_kind IS NOT DISTINCT FROM 'numeric'",
      "meta->>'derived_stats_max_age_hours' IS NOT DISTINCT FROM '168'",
      'expected_count IS NOT DISTINCT FROM 10000',
      'page_size IS NOT DISTINCT FROM 5000',
      "meta->>'board_depth' IS NOT DISTINCT FROM '10000'",
      "meta->>'inst_type' IS NOT DISTINCT FROM 'SWAP'",
      'page_size IS NOT DISTINCT FROM 6',
    ]) {
      expect(migration).toContain(predicate)
    }
    expect(migration).toContain("status <> 'active'")
    expect(migration).toContain("slug = 'bitmart_futures' OR adapter_slug = 'bitmart'")
    expect(migration).toContain(
      "slug = ANY (ARRAY['okx_futures', 'okx_spot']::text[])\n        OR adapter_slug = 'okx'"
    )
  })

  it('ships a PostgreSQL 17 proof for replay, drift rejection, and state preservation', () => {
    for (const marker of [
      'source registry runtime contract PostgreSQL 17 proof passed',
      'successful migration changed source serving state',
      'replayed migration changed the canonical source contract',
      'nullable page size',
      'removed derived freshness evidence',
      'removed OKX product identity',
      'nullable Hyperliquid capacity',
      'reactivating drifted inactive source',
      'rogue active adapter identity',
      'reviewed source identity drifted',
    ]) {
      expect(pg17).toContain(marker)
    }
    expect(pg17).toContain('-f "$MIGRATION"')
    expect(pg17).toContain('sources_active_adapter_runtime_contract')
    expect(pg17).toContain('convalidated')
  })
})
