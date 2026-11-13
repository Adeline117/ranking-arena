import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const source = readFileSync(join(root, 'app/api/cron/meta-monitor/route.ts'), 'utf8')

function expectedJobs(): string[] {
  const start = source.indexOf('const EXPECTED_INTERVALS')
  const end = source.indexOf('\n}\n', start)
  const block = source.slice(start, end)
  return [...block.matchAll(/^\s*'([a-z0-9-]+)':\s*\d+,/gm)].map((m) => m[1])
}

describe('meta-monitor expected intervals', () => {
  it('parses a non-empty job list', () => {
    expect(expectedJobs().length).toBeGreaterThan(5)
  })

  it('only expects jobs that still have a cron route (no permanent NEVER alarms)', () => {
    const missing = expectedJobs().filter(
      (job) => !existsSync(join(root, 'app/api/cron', job, 'route.ts'))
    )
    expect(missing).toEqual([])
  })

  it.each([
    'batch-fetch-traders',
    'batch-enrich',
    'fetch-details',
    'backfill-data',
    'link-entities',
    'verify-fetchers',
    'snapshot-positions',
    'auto-post-insights',
  ])('no longer expects removed job %s', (job) => {
    expect(expectedJobs()).not.toContain(job)
  })
})
