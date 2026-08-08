import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260804054600_correct_copier_depth_contracts.sql'),
  'utf8'
)
const proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/correct-copier-depth-contracts.pg17.sh'),
  'utf8'
)

describe('reviewed copier depth contract correction', () => {
  it('is one locked PG17 owner transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain("current_user IS DISTINCT FROM 'postgres'")
    expect(migration).toContain('LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain('20260804-correct-reviewed-copier-depth-contracts')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('pins every reviewed source identity before changing its claim', () => {
    for (const slug of [
      'gate_futures',
      'gate_cfd',
      'bybit_copytrade',
      'bingx_futures',
      'bingx_spot',
      'blofin_futures',
      'blofin_spot',
      'htx_futures',
      'htx_spot',
      'phemex_futures',
      'bitmart_futures',
    ]) {
      expect(migration).toContain(`\"slug\":\"${slug}\"`)
    }
    expect(migration).toContain('source_row.adapter_slug IS DISTINCT FROM expected.adapter')
    expect(migration).toContain('source_row.product_type IS DISTINCT FROM expected.product')
    expect(migration).toContain('source_row.trader_kind_scope IS DISTINCT FROM expected.scope')
    expect(migration).toContain('source_row.currency IS DISTINCT FROM expected.currency')
    expect(migration).toContain(
      'source_row.copier_table_depth IS DISTINCT FROM expected."oldDepth"'
    )
    expect(migration).toContain(
      'source_row.copier_table_depth IS DISTINCT FROM expected."targetDepth"'
    )
    expect(migration).toContain('requires exactly one canonical source per slug')
  })

  it('promotes only the proved Gate futures scan and fails every unsupported claim closed', () => {
    expect(migration).toMatch(/\('gate_futures', 'full'\)/)
    for (const slug of [
      'gate_cfd',
      'bybit_copytrade',
      'bingx_futures',
      'bingx_spot',
      'blofin_futures',
      'blofin_spot',
      'htx_futures',
      'htx_spot',
      'phemex_futures',
      'bitmart_futures',
    ]) {
      expect(migration).toContain(`('${slug}', 'none')`)
    }
    expect(migration).toContain(
      'https://www.gate.com/api/copytrade/copy_trading/trader/follow_user'
    )
    expect(migration).toContain("source_row.meta->>'boardKey' IS DISTINCT FROM 'futures'")
    expect(migration).toContain('LBank is intentionally absent')
    expect(migration).not.toContain('\"slug\":\"lbank_futures\"')
    expect(migration).not.toContain("('lbank_futures', 'full')")
  })

  it('proves drift rejection, update, isolation, and replay on PostgreSQL 17', () => {
    for (const marker of [
      'missing canonical source was accepted',
      'duplicate canonical source was accepted',
      'adapter drift was accepted',
      'scope drift was accepted',
      'depth drift was accepted',
      'Gate board drift was accepted',
      'Gate endpoint drift was accepted',
      'reviewed copier depth correction drifted',
      'depth correction mutated an excluded source',
      'lbank_futures|lbank|futures|human|USDT|top3_preview',
      'reviewed copier depth replay drifted',
      'reviewed copier depth contracts 054600 PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })
})
