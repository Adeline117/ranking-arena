import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260804054500_correct_okx_copier_depth_contract.sql'),
  'utf8'
)
const proof = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/correct-okx-copier-depth-contract.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

describe('OKX copier depth contract correction', () => {
  it('is one locked PG17 transaction', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(migration).toContain("current_user IS DISTINCT FROM 'postgres'")
    expect(migration).toContain('LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE')
    expect(migration).toContain('20260804-correct-okx-copier-depth-contract')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('requires exactly one canonical futures and spot identity', () => {
    expect(migration).toContain("source_row.slug = 'okx_futures'")
    expect(migration).toContain("source_row.slug = 'okx_spot'")
    expect(migration).toContain('requires exactly one futures and one spot source')
    expect(migration).toContain("v_futures.adapter_slug IS DISTINCT FROM 'okx'")
    expect(migration).toContain("v_futures.product_type IS DISTINCT FROM 'futures'")
    expect(migration).toContain("v_spot.product_type IS DISTINCT FROM 'spot'")
    expect(migration).toContain("v_futures.currency IS DISTINCT FROM 'USDT'")
    expect(migration).toContain("v_spot.currency IS DISTINCT FROM 'USDT'")
  })

  it('allows only the reviewed old or target depth states', () => {
    expect(migration).toMatch(
      /v_futures\.copier_table_depth IS DISTINCT FROM 'full'[\s\S]*v_futures\.copier_table_depth IS DISTINCT FROM 'top10'/
    )
    expect(migration).toMatch(
      /v_spot\.copier_table_depth IS DISTINCT FROM 'full'[\s\S]*v_spot\.copier_table_depth IS DISTINCT FROM 'none'/
    )
    expect(migration).toMatch(
      /SET copier_table_depth = 'top10'[\s\S]*slug = 'okx_futures'[\s\S]*copier_table_depth = 'full'/
    )
    expect(migration).toMatch(
      /SET copier_table_depth = 'none'[\s\S]*slug = 'okx_spot'[\s\S]*copier_table_depth = 'full'/
    )
  })

  it('fails closed on product metadata and custom copier endpoint drift', () => {
    expect(migration).toContain("v_futures.meta->>'inst_type' IS DISTINCT FROM 'SWAP'")
    expect(migration).toContain("v_spot.meta->>'inst_type' IS DISTINCT FROM 'SPOT'")
    expect(migration).toContain('https://www.okx.com/api/v5/copytrading')
    expect(migration).toContain("'copy_traders_endpoint'")
    expect(migration).toContain("'public_copy_traders'")
    expect(migration).toContain('custom copier endpoint drifted')
  })

  it('proves update, replay, isolation, and every required drift rejection on PG17', () => {
    for (const marker of [
      'missing canonical OKX source was accepted',
      'duplicate canonical OKX source was accepted',
      'adapter drift was accepted',
      'product drift was accepted',
      'currency drift was accepted',
      'unexpected futures depth pre-state was accepted',
      'unexpected spot depth pre-state was accepted',
      'custom OKX copier endpoint was accepted',
      'canonical OKX depth correction drifted',
      'OKX correction mutated another source',
      'OKX depth correction replay drifted',
      'OKX copier depth contract 054500 PostgreSQL 17 proof passed',
    ]) {
      expect(proof).toContain(marker)
    }
  })

  it('runs after the 054200 hardening while the manual 055000 cutover stays absent', () => {
    const predeployStart = runner.indexOf('PREDEPLOY_MIGRATIONS=(')
    const predeployEnd = runner.indexOf('\n)', predeployStart)
    const predeploy = runner.slice(predeployStart, predeployEnd)
    const postdeployStart = runner.indexOf('POSTDEPLOY_MIGRATIONS=(')
    const postdeployEnd = runner.indexOf('\n)', postdeployStart)
    const postdeploy = runner.slice(postdeployStart, postdeployEnd)
    const authority = '20260804054000_copier_snapshot_publication_authority.sql'
    const provenance = '20260804054200_harden_copier_snapshot_receipt_provenance.sql'
    const correction = '20260804054500_correct_okx_copier_depth_contract.sql'
    const cutover = '20260804055000_copier_snapshot_direct_write_cutover.sql'

    expect(predeploy).toContain(`${authority}\n  ${provenance}\n  ${correction}`)
    expect(predeploy).not.toContain(cutover)
    expect(postdeploy).not.toContain(cutover)
  })
})
