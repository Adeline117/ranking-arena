import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { META_MONITOR_EXPECTED_INTERVALS } from '@/lib/cron/meta-monitor-policy'

const jobs = Object.keys(META_MONITOR_EXPECTED_INTERVALS)

describe('meta-monitor expected intervals', () => {
  it('only expects jobs that still have a cron route (no permanent NEVER alarms)', () => {
    const missing = jobs.filter(
      (job) => !existsSync(join(process.cwd(), 'app/api/cron', job, 'route.ts'))
    )
    expect(missing).toEqual([])
  })

  // 410 tombstones whose work moved into the worker never write pipeline_logs.
  it.each(['compute-leaderboard', 'precompute-composite', 'sync-meilisearch'])(
    'does not expect the tombstoned job %s',
    (job) => {
      expect(jobs).not.toContain(job)
    }
  )

  it('watches the worker liveness checker that reads the progress watermarks', () => {
    expect(META_MONITOR_EXPECTED_INTERVALS['worker-heartbeat-check']).toBe(15)
  })
})
