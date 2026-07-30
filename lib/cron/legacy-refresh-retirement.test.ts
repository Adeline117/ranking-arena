import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('legacy refresh_jobs scheduler retirement', () => {
  it('does not schedule or monitor the retired discover queue', () => {
    const vercelConfig = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons: Array<{ path: string }>
    }
    const monitorSource = readFileSync(
      join(process.cwd(), 'app/api/cron/meta-monitor/route.ts'),
      'utf8'
    )
    const batchSource = readFileSync(
      join(process.cwd(), 'app/api/cron/batch-5min/route.ts'),
      'utf8'
    )

    expect(vercelConfig.crons.map(({ path }) => path)).not.toContain('/api/cron/batch-discover')
    expect(monitorSource).not.toContain("'batch-discover'")
    expect(batchSource).not.toContain('runWorkerInline')
  })
})
