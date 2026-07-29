import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/cron/daily-digest/route.ts'), 'utf8')

describe('daily operational digest authority', () => {
  it('uses the canonical registry, visibility, and watermark freshness report', () => {
    expect(route).toContain('buildFreshnessReport(freshnessSignal)')
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
    expect(route).toContain('if (logsError || !Array.isArray(logs))')
    expect(route).toContain("typeof snapshotCount24h !== 'number'")
    expect(route).toContain('!Number.isSafeInteger(snapshotCount24h)')
    expect(route).toContain("typeof snapshotCountYesterday !== 'number'")
    expect(route).toContain('!Number.isSafeInteger(snapshotCountYesterday)')
    expect(route).toContain('if (errorLogsError || !Array.isArray(errorLogs))')
    expect(route).toContain("throw new Error('Daily digest delivery failed')")
  })

  it('reads all independent inputs concurrently under one bounded signal', () => {
    expect(route).toContain('const dataSignal = AbortSignal.timeout(40_000)')
    expect(route).toContain('const freshnessSignal = AbortSignal.any')
    expect(route.match(/\.abortSignal\(dataSignal\)/g)).toHaveLength(4)
    expect(route).toContain('] = await Promise.all([')
    expect(route).toContain('{ safetyTimeoutMs: 115_000 }')
  })
})
