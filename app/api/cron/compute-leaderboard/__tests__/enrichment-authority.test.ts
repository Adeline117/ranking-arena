/**
 * @jest-environment node
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8')
const dailyAggregator = readFileSync(
  join(__dirname, '..', '..', 'aggregate-daily-snapshots', 'route.ts'),
  'utf8'
)

describe('leaderboard enrichment authority', () => {
  it('does not score any season from the periodless 90D daily snapshot history', () => {
    expect(dailyAggregator).toContain(
      "readSealedRankingAuthorityGeneration(\n    readDb,\n    '90D'"
    )
    expect(route).not.toContain('deriveAdvancedFromDailySnapshots')
    expect(route).not.toContain("from './enrich-daily-snapshots'")
    expect(route).toContain('trader_daily_snapshots is deliberately excluded')
  })
})
