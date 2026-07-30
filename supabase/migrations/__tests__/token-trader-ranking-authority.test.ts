import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const migrationsDir = join(process.cwd(), 'supabase/migrations')
const migrationNames = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()

const latestTokenRankingMigration = [...migrationNames].reverse().find((name) => {
  const sql = readFileSync(join(migrationsDir, name), 'utf8')
  return /CREATE OR REPLACE FUNCTION public\.get_token_trader_rankings\s*\(/i.test(sql)
})

if (!latestTokenRankingMigration) {
  throw new Error('Missing get_token_trader_rankings migration')
}

const sql = readFileSync(join(migrationsDir, latestTokenRankingMigration), 'utf8')
const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
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

  it('is database-first, reloads PostgREST, and has a live return-contract probe', () => {
    const predeployStart = runner.indexOf('PREDEPLOY_MIGRATIONS=(')
    const quarantineStart = runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    const tokenMigration = '20260729225000_token_trader_rank_authority.sql'
    const tokenMigrationIndex = runner.indexOf(tokenMigration, predeployStart)

    expect(tokenMigrationIndex).toBeGreaterThan(predeployStart)
    expect(tokenMigrationIndex).toBeLessThan(quarantineStart)
    expect(normalized).toContain("notify pgrst, 'reload schema'")
    expect(normalized).toContain('token ranking function authority postflight failed')
    expect(runbook).toContain('/rest/v1/rpc/get_token_trader_rankings')
    expect(runbook).toContain('.[0].token_rank')
  })
})
