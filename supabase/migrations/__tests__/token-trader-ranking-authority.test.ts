import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const authorityMigration = '20260729225000_token_trader_rank_authority.sql'
const retirementMigration = '20260804043000_retire_legacy_token_rankings.sql'
const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations', authorityMigration), 'utf8')
const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
const retirement = readFileSync(
  resolve(process.cwd(), 'supabase/migrations', retirementMigration),
  'utf8'
)
const normalizedRetirement = retirement.replace(/\s+/g, ' ').toLowerCase()
const runner = readFileSync(
  resolve(process.cwd(), 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)
const runbook = readFileSync(resolve(process.cwd(), 'docs/RUNBOOK.md'), 'utf8')

describe('get_token_trader_rankings SQL authority', () => {
  it('returns a deterministic token_rank before limit/offset pagination', () => {
    expect(normalized).toContain('token_rank bigint')
    expect(normalized).toMatch(
      /(?:pg_catalog\.)?row_number\(\) over \(\s*order by totals\.token_pnl desc, totals\.source asc, totals\.source_trader_id asc\s*\) as token_rank/
    )

    const rankIndex = normalized.indexOf('row_number() over')
    const limitIndex = normalized.indexOf('limit greatest')
    const offsetIndex = normalized.indexOf('offset greatest')
    expect(rankIndex).toBeGreaterThanOrEqual(0)
    expect(limitIndex).toBeGreaterThan(rankIndex)
    expect(offsetIndex).toBeGreaterThan(rankIndex)
    expect(normalized).toMatch(/order by (?:ranked\.)?token_rank(?: asc)?/)
  })

  it('keeps the historical database-first contract but documents its fail-closed retirement', () => {
    const predeployStart = runner.indexOf('PREDEPLOY_MIGRATIONS=(')
    const quarantineStart = runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    const tokenMigrationIndex = runner.indexOf(authorityMigration, predeployStart)

    expect(tokenMigrationIndex).toBeGreaterThan(predeployStart)
    expect(tokenMigrationIndex).toBeLessThan(quarantineStart)
    expect(normalized).toContain("notify pgrst, 'reload schema'")
    expect(normalized).toContain('token trader ranking return contract postflight failed')
    expect(normalized).toContain('token trader ranking acl postflight failed')
    expect(normalizedRetirement).toContain(
      'legacy token rankings are retired; authority snapshot required'
    )
    expect(runbook).toContain(retirementMigration)
    expect(runbook).toContain('/rest/v1/rpc/get_token_ranking_publication_head')
    expect(runbook).toContain('legacy_token_rpcs_closed')
    expect(runbook).not.toContain('.[0].token_rank')
  })
})
