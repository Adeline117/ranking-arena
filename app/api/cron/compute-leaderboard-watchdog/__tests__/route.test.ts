import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/compute-leaderboard-watchdog/route.ts'),
  'utf8'
)

describe('compute leaderboard watchdog route', () => {
  it('aborts freshness reads and fails closed on query errors', () => {
    expect(route).toContain('const freshnessSignal = AbortSignal.any')
    expect(route).toContain('.abortSignal(freshnessSignal)')
    expect(route).toContain('throw new Error(`Leaderboard freshness query failed')
    expect(route).not.toContain('return { checked: false')
  })

  it('reports trigger failures accurately and fails the cron run', () => {
    expect(route).toContain('triggerSeasonCompute(base, secret, s.season, { signal: workSignal })')
    expect(route).toContain("'compute-leaderboard 看门狗触发失败'")
    expect(route).toContain('不得视为已兜底')
    expect(route).toContain('if (!allAcknowledged)')
    expect(route).toContain('throw new Error(')
  })
})
