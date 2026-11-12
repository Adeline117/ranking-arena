import { readFileSync } from 'node:fs'
import path from 'node:path'

const MIGRATIONS_DIR = path.resolve(__dirname, '..')
const read = (name: string) => readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')

const hold = read('20261111191927_binance_spot_contract_registration_serving_hold.sql')
const restore = read('20261111191928_binance_spot_contract_registration_serving_restore.sql')
const registration = read('20260722053000_binance_spot_metric_source_contract.sql')

// Owner decision 2026-11-11: keep Binance Spot on the leaderboard. 053 is applied
// unchanged (055 pins its exact ledger body), bracketed by a marked hold/restore.
describe('Binance Spot contract-registration serving hold', () => {
  it('brackets the unchanged 053 registration, which still refuses serving sources', () => {
    expect(registration).toContain(
      'Binance Spot must be non-serving and non-dropped before contract registration'
    )
    expect(hold).toContain('must run before 20260722053000')
    expect(restore).toContain('requires the committed 20260722053000 ledger row')
  })

  it('holds only an active, serving, contract-free binance_spot and marks it', () => {
    expect(hold).toContain("WHERE source.slug = 'binance_spot'")
    expect(hold).toContain("AND source.status = 'active'")
    expect(hold).toContain("AND source.serving_mode = 'serving'")
    expect(hold).toContain("serving_mode = 'shadow'")
    expect(hold).toContain("'launch_contract_registration_hold', '20260722053000'")
    expect(hold).toMatch(/NOT EXISTS \(\s*SELECT 1\s*FROM arena\.metric_source_contracts/u)
  })

  it('restores serving only for the marked row and clears the marker', () => {
    expect(restore).toContain(
      "source.meta->>'launch_contract_registration_hold' = '20260722053000'"
    )
    expect(restore).toContain("serving_mode = 'serving'")
    expect(restore).toContain("meta = source.meta - 'launch_contract_registration_hold'")
    expect(restore).toMatch(/IF v_updated <> 1 THEN/u)
    // No marker -> no-op, so replay is safe.
    expect(restore).toMatch(/IF NOT EXISTS \([\s\S]*?\) THEN\s*RETURN;/u)
  })

  it('never changes status or any other source', () => {
    for (const sql of [hold, restore]) {
      expect(sql).not.toMatch(/SET\s+status\s*=/u)
      expect(sql).not.toMatch(/\bstatus\s*=\s*'(?!active')/u)
      expect(sql.match(/UPDATE arena\.sources/gu)).toHaveLength(1)
    }
  })
})
