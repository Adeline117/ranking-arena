import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/cron/daily-digest/route.ts'), 'utf8')

describe('daily operational digest authority', () => {
  it('uses the canonical registry, visibility, and watermark freshness report', () => {
    expect(route).toContain('buildFreshnessReport(AbortSignal.timeout(30_000))')
    expect(route).not.toContain(".from('leaderboard_ranks')")
    expect(route).not.toContain("select('computed_at')")
  })

  it('counts actual daily snapshots instead of recomputed rank rows', () => {
    expect(route.match(/\.from\('trader_daily_snapshots'\)/g)).toHaveLength(2)
    expect(route).toContain(".gte('created_at', oneDayAgo)")
    expect(route).toContain(".gte('created_at', twoDaysAgo)")
    expect(route).toContain(".lt('created_at', oneDayAgo)")
  })

  it('fails closed on every input or Telegram delivery failure', () => {
    expect(route).toContain('if (logsError || logs === null)')
    expect(route).toContain('if (snapshotCount24hError)')
    expect(route).toContain('if (snapshotCountYesterdayError)')
    expect(route).toContain('if (errorLogsError || errorLogs === null)')
    expect(route).toContain("throw new Error('Daily digest delivery failed')")
  })
})
