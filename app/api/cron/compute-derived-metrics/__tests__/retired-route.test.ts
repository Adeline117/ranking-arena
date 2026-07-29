import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/compute-derived-metrics/route.ts'),
  'utf8'
)
const vercel = readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')
const monitor = readFileSync(join(process.cwd(), 'app/api/cron/meta-monitor/route.ts'), 'utf8')
const pipelineLogger = readFileSync(join(process.cwd(), 'lib/services/pipeline-logger.ts'), 'utf8')

describe('retired derived metrics writer', () => {
  it('cannot mutate the removed snapshot table or a published ranking generation', () => {
    expect(route).not.toContain('supabase.rpc')
    expect(route).not.toContain("from('leaderboard_ranks')")
    expect(route).not.toContain("from('trader_daily_snapshots')")
    expect(route).toContain('export const maxDuration = 10')
    expect(route).toContain('compute-leaderboard atomic generation')
    expect(route).toContain('{ status: 410 }')
  })

  it('is absent from scheduling and dead-man monitoring', () => {
    expect(vercel).not.toContain('/api/cron/compute-derived-metrics')
    expect(monitor).not.toContain("'compute-derived-metrics'")
    expect(pipelineLogger).not.toContain("'compute-derived-metrics'")
  })
})
