import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729061000_source_legacy_platform_alias_contract.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/source-legacy-platform-alias-contract.pg17.sh'),
  'utf8'
)

const mappings = [
  ['mexc_futures', 'mexc', 'mexc', 'futures', 'mixed', 'mexc'],
  ['gate_futures', 'gate', 'gate', 'futures', 'human', 'gateio'],
  ['bingx_futures', 'bingx', 'bingx', 'futures', 'human', 'bingx'],
  ['bybit_copytrade', 'bybit_copytrade', 'bybit', 'futures', 'mixed', 'bybit'],
  ['binance_web3_bsc', 'binance_web3', 'binance_web3', 'onchain', 'human', 'binance_web3'],
  ['kucoin_futures', 'kucoin', 'kucoin', 'futures', 'mixed', 'kucoin'],
  ['bitunix_futures', 'bitunix', 'bitunix', 'futures', 'human', 'bitunix'],
  ['phemex_futures', 'phemex', 'phemex', 'futures', 'mixed', 'phemex'],
  ['btcc_futures', 'btcc', 'btcc', 'futures', 'human', 'btcc'],
  ['lbank_futures', 'lbank', 'lbank', 'futures', 'human', 'lbank'],
  ['blofin_futures', 'blofin', 'blofin', 'futures', 'mixed', 'blofin'],
  ['xt_futures', 'xt', 'xt', 'futures', 'human', 'xt'],
  ['coinex_futures', 'coinex', 'coinex', 'futures', 'human', 'coinex'],
] as const

describe('source legacy-platform alias contract', () => {
  it('ships the exact thirteen reviewed source identities', () => {
    for (const mapping of mappings) {
      expect(migration).toContain(`('${mapping.join("', '")}')`)
    }
    expect(migration).toContain('expected exactly thirteen legacy-platform source rows')
    expect(migration).toContain('legacy-platform source identity drifted for %')
    expect(migration).toContain('pg_catalog.jsonb_typeof(source.meta)')
  })

  it('initializes only missing aliases and preserves serving state plus unrelated metadata', () => {
    expect(migration).toContain("AND NOT (source.meta ? 'legacy_platform')")
    expect(migration).toContain('pg_catalog.jsonb_set(')
    expect(migration).toContain('pg_catalog.to_jsonb(target.legacy_platform)')
    expect(migration).not.toMatch(
      /UPDATE\s+arena\.sources[\s\S]{0,300}\b(?:status|serving_mode)\s*=/i
    )
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on conflicting values and protected namespace collisions', () => {
    expect(migration).toContain("source.meta ? 'legacy_platform'")
    expect(migration).toContain(
      "source.meta->>'legacy_platform' IS DISTINCT FROM target.legacy_platform"
    )
    expect(migration).toContain('existing legacy_platform conflicts with the reviewed alias for %')
    expect(migration).toContain('protected legacy-platform namespace conflict for %')
    expect(migration).toContain('other_source.slug = target.legacy_platform')
    expect(migration).toContain("other_source.meta->>'legacy_platform' = target.legacy_platform")
    expect(migration).toContain("other_source.meta->>'legacy_platform' = target.slug")
  })

  it('serializes registry repair and prevents drifted inactive rows from reactivation', () => {
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("'arena.sources:legacy-platform-alias-contract:v1'")
    expect(migration).toContain("'arena.publish-board-series:' || v_source_id::text")
    expect(migration).toContain('LOCK TABLE arena.sources IN SHARE MODE')
    expect(migration).toContain('LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain('ADD CONSTRAINT sources_active_legacy_platform_alias_contract')
    expect(migration).toContain('VALIDATE CONSTRAINT sources_active_legacy_platform_alias_contract')
    expect(migration).toContain("status <> 'active'")
    expect(migration).toContain('OR COALESCE((')
    for (const [slug, adapter, , product, kind, alias] of mappings) {
      expect(migration).toContain(`WHEN '${slug}' THEN`)
      expect(migration).toContain(`adapter_slug = '${adapter}'`)
      expect(migration).toContain(`product_type = '${product}'`)
      expect(migration).toContain(`trader_kind_scope = '${kind}'`)
      expect(migration).toContain(`meta->>'legacy_platform' IS NOT DISTINCT FROM '${alias}'`)
    }
  })

  it('includes a PostgreSQL 17 proof for replay, conflicts, and deactivate/reactivate', () => {
    for (const marker of [
      'source legacy-platform alias contract PostgreSQL 17 proof passed',
      'fresh seed alias replay passed',
      'successful migration changed source serving state',
      'successful migration overwrote unrelated source metadata',
      'replayed migration changed the canonical alias contract',
      'active alias removal',
      'reactivating drifted inactive alias',
      'existing alias conflict',
      'protected alias collision',
      'protected canonical slug collision',
      'legacy-platform source identity drifted',
    ]) {
      expect(pg17).toContain(marker)
    }
    expect(pg17).toContain('-f "$MIGRATION"')
    expect(pg17).toContain('sources_active_legacy_platform_alias_contract')
    expect(pg17).toContain('convalidated')
  })
})
