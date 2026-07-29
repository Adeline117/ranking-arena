import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationName = '20260728122000_bitget_bots_canonical_timeframe.sql'
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationName), 'utf8')

describe('Bitget bots canonical board timeframe', () => {
  it('is one bounded atomic and replay-safe source convergence', () => {
    expect(migration).toMatch(/^-- Migration:[\s\S]*\nBEGIN;/)
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'")
    expect(migration).toContain("to_regclass('arena.sources')")
    expect(migration).toContain("to_regclass('arena.exchanges')")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)

    const registryFreeze = migration.indexOf('LOCK TABLE arena.sources IN SHARE MODE')
    const advisory = migration.indexOf("'arena.publish-board-series:' || v_source_id::text")
    const sourceLock = migration.indexOf('LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE')
    const update = migration.indexOf('UPDATE arena.sources AS source')
    expect(registryFreeze).toBeGreaterThan(-1)
    expect(advisory).toBeGreaterThan(registryFreeze)
    expect(advisory).toBeGreaterThan(-1)
    expect(sourceLock).toBeGreaterThan(advisory)
    expect(update).toBeGreaterThan(sourceLock)
    expect(migration).toContain('ORDER BY source.id')
  })

  it('pins exactly the two reviewed active Bitget bot source identities', () => {
    expect(migration).toContain('expected exactly two Bitget bot source rows')
    expect(migration).toContain("exchange.slug = 'bitget'")
    expect(migration).toContain("source.adapter_slug IS DISTINCT FROM 'bitget_bots'")
    expect(migration).toContain("source.trader_kind_scope IS DISTINCT FROM 'bot'")
    expect(migration).toContain("source.status IS DISTINCT FROM 'active'")
    expect(migration).toContain("source.serving_mode IS DISTINCT FROM 'serving'")
    expect(migration).toContain("source.currency IS DISTINCT FROM 'USDT'")
    expect(migration).toContain("('bitget_bots_futures'::text, 'futures'::text)")
    expect(migration).toContain("('bitget_bots_spot'::text, 'spot'::text)")
    expect(migration).toContain(
      'unexpected active Bitget bot source requires an explicit canonical timeframe review'
    )

    for (const slug of ['bitget_bots_futures', 'bitget_bots_spot']) {
      expect(migration).toContain(slug)
    }
    for (const unrelated of ['bitget_futures', 'bitget_spot', 'bitget_cfd']) {
      expect(migration).not.toMatch(new RegExp(`['"]${unrelated}['"](?:\\s*,|\\s*\\)|::text)`))
    }
  })

  it('accepts only the historical seed or exact 30D numeric replay state before convergence', () => {
    expect(migration).toContain(
      'source.timeframes_native IS NOT DISTINCT FROM ARRAY[7, 30, 90]::integer[]'
    )
    expect(migration).toContain(
      'source.timeframes_native IS NOT DISTINCT FROM ARRAY[30]::integer[]'
    )
    expect(migration).toContain('source.timeframes_derived IS DISTINCT FROM ARRAY[]::integer[]')
    expect(migration).toContain('source.page_size IS NULL')
    expect(migration).toContain("source.pagination_kind IS NOT DISTINCT FROM 'infinite_scroll'")
    expect(migration).toContain('source.page_size IS NOT DISTINCT FROM 20')
    expect(migration).toContain("source.pagination_kind IS NOT DISTINCT FROM 'numeric'")
    expect(migration).toMatch(
      /UPDATE arena\.sources AS source[\s\S]*SET timeframes_native = ARRAY\[30\]::integer\[\],[\s\S]*page_size = 20,[\s\S]*pagination_kind = 'numeric'[\s\S]*FROM \([\s\S]*bitget_bots_futures[\s\S]*bitget_bots_spot[\s\S]*source\.timeframes_native IS DISTINCT FROM ARRAY\[30\]::integer\[\]/
    )
    expect(migration).toContain('GET DIAGNOSTICS v_updated = ROW_COUNT')
    expect(migration).toContain('v_updated <> v_expected_updates')

    expect(migration.match(/UPDATE arena\.sources AS source/g)).toHaveLength(1)
    expect(migration).not.toMatch(/\b(?:INSERT INTO|DELETE FROM)\s+arena\.sources\b/i)
    expect(migration).not.toMatch(
      /SET\s+(?:status|adapter_slug|trader_kind_scope|product_type)\s*=/i
    )
  })

  it('installs a durable active-source contract without blocking deliberate deactivation', () => {
    const constraint = 'sources_active_bitget_bots_canonical_board_contract'
    expect(migration).toContain(`DROP CONSTRAINT IF EXISTS ${constraint}`)
    expect(migration).toContain(`ADD CONSTRAINT ${constraint}`)
    expect(migration).toContain(`VALIDATE CONSTRAINT ${constraint}`)
    expect(migration).toContain("status <> 'active'")
    expect(migration).toContain("adapter_slug = 'bitget_bots'")
    expect(migration).toContain("trader_kind_scope = 'bot'")
    expect(migration).toContain("serving_mode = 'serving'")
    expect(migration).toContain("currency = 'USDT'")
    expect(migration).toContain("adapter_slug IS DISTINCT FROM 'bitget_bots'")
    expect(migration).toContain('timeframes_native IS NOT DISTINCT FROM ARRAY[30]::integer[]')
    expect(migration).toContain('timeframes_derived IS NOT DISTINCT FROM ARRAY[]::integer[]')
    expect(migration).toContain('page_size IS NOT DISTINCT FROM 20')
    expect(migration).toContain("pagination_kind IS NOT DISTINCT FROM 'numeric'")
    expect(migration).toMatch(/meta->'boards' IS NOT DISTINCT FROM/)
    expect(migration).toContain('["futures_grid", "futures_martingale"]')
    expect(migration).toContain('["spot_grid", "spot_martingale"]')
    expect(migration).toContain('slug <> ALL (')
    expect(migration).toContain('constraint_row.convalidated')
    expect(migration).toContain('Bitget bot canonical timeframe postflight failed')
  })
})
