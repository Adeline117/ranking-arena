import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/precompute-composite/route.ts'),
  'utf8'
)
const vercel = readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')
const monitor = readFileSync(join(process.cwd(), 'app/api/cron/meta-monitor/route.ts'), 'utf8')
const pipelineLogger = readFileSync(join(process.cwd(), 'lib/services/pipeline-logger.ts'), 'utf8')

describe('retired composite cache writer', () => {
  it('cannot publish unsealed leaderboard rows or a legacy Redis payload', () => {
    expect(route).not.toContain("from('leaderboard_ranks')")
    expect(route).not.toContain('getPool')
    expect(route).not.toContain('tieredSet')
    expect(route).toContain('/api/rankings?window=composite')
    expect(route).toContain('{ status: 410 }')
  })

  it('is absent from scheduling and dead-man monitoring', () => {
    expect(vercel).not.toContain('/api/cron/precompute-composite')
    expect(monitor).not.toContain("'precompute-composite'")
    expect(pipelineLogger).not.toContain("'precompute-composite'")
  })
})
