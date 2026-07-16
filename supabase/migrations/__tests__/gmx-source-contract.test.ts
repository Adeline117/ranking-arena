import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260715231500_fix_gmx_source_contract.sql'),
  'utf8'
)

describe('GMX source contract migration', () => {
  it('is atomic, bounded, and fails unless exactly one source row changes', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain("WHERE slug = 'gmx'")
    expect(migration).toContain('IF v_updated <> 1 THEN')
    expect(migration).toContain('gmx source contract verification failed')
  })

  it('declares only exact 7/30 native and marks 90d unavailable', () => {
    expect(migration).toContain('timeframes_native = ARRAY[7, 30]::integer[]')
    expect(migration).toContain('timeframes_derived = ARRAY[]::integer[]')
    expect(migration).toContain("- 'compute_90d'")
    expect(migration).toContain("'90', 'pending_exact_event_reconstruction'")
  })

  it('pins the production graph and discloses Arena realized-net semantics', () => {
    expect(migration).toContain('https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql')
    expect(migration).toContain("'pnl_basis_board', 'gmx_period_realized_net'")
    expect(migration).toContain("'roi_basis_board', 'max_capital_usd'")
    expect(migration).toContain("'pnl_includes_unrealized', false")
    expect(migration).toContain("'pnl_contract_version', 2")
  })
})
