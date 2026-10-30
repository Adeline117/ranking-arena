/**
 * @jest-environment node
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const leaderboardDir = join(process.cwd(), 'app/api/cron/compute-leaderboard')
const route = readFileSync(join(leaderboardDir, 'route.ts'), 'utf8')
const helpers = readFileSync(join(leaderboardDir, 'helpers.ts'), 'utf8')
const productionSources = readdirSync(leaderboardDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => readFileSync(join(leaderboardDir, entry.name), 'utf8'))
  .join('\n')

describe('leaderboard enrichment authority', () => {
  it('does not score any season from periodless daily snapshot history', () => {
    expect(route).not.toContain('deriveAdvancedFromDailySnapshots')
    expect(route).not.toContain("from './enrich-daily-snapshots'")
    expect(route).not.toContain('trader_daily_snapshots')
    expect(existsSync(join(leaderboardDir, 'enrich-daily-snapshots.ts'))).toBe(false)
    expect(helpers).not.toContain('deriveWinRateMDD')
    expect(helpers).not.toContain('trader_daily_snapshots')
    expect(productionSources).not.toMatch(/\.from\(\s*['"]trader_daily_snapshots['"]\s*\)/)
  })
})
