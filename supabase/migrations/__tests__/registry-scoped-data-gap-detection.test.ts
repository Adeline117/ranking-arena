import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260730020000_registry_scoped_data_gap_detection.sql'),
  'utf8'
)

describe('registry-scoped data gap detection migration', () => {
  it('derives both RPC scopes from active serving ranking authority', () => {
    expect(migration.match(/public\.arena_freshness_expected_sources\(\)/g)).toHaveLength(2)
    expect(migration.match(/JOIN eligible_sources AS eligible/g)).toHaveLength(2)
    expect(migration).not.toContain('NOT IN (')
    expect(migration).not.toMatch(/'lbank'|'bitget_spot'|'drift'|'paradex'/)
  })

  it('keeps bounded deterministic details and exact stale aggregation', () => {
    expect(migration).toContain('LIMIT p_limit')
    expect(migration).toContain('ORDER BY gap_hours DESC, gap.source, gap.source_trader_id')
    expect(migration.match(/pg_catalog\.max\(rank\.computed_at\)/g).length).toBeGreaterThanOrEqual(
      4
    )
    expect(migration).toContain('GROUP BY trader.source, trader.source_trader_id')
  })

  it('is service-only with hardened definer search paths', () => {
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(2)
    expect(migration.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(2)
    expect(migration).toContain('FROM PUBLIC, anon, authenticated')
    expect(migration).toContain('TO service_role')
    expect(migration).not.toContain('TO anon, authenticated')
  })
})
