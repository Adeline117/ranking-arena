import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEAD_BLOCKED_PLATFORMS,
  SOURCES_WITH_DATA,
  type TraderSource,
} from '@/lib/constants/exchanges'
import { AVATAR_BACKFILL_SCHEDULE_PLATFORMS } from '../platforms'

interface VercelConfig {
  crons: Array<{ path: string; schedule: string }>
}

describe('avatar backfill schedule contract', () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')
  ) as VercelConfig
  const jobs = config.crons.filter((job) => job.path.startsWith('/api/cron/backfill-avatars?'))

  it('schedules exactly the canonical fetcher-backed platform list', () => {
    expect(jobs).toHaveLength(1)

    const url = new URL(jobs[0].path, 'https://arena.test')
    const scheduledPlatforms = url.searchParams.get('platform')?.split(',') ?? []

    expect(scheduledPlatforms).toEqual([...AVATAR_BACKFILL_SCHEDULE_PLATFORMS])
    expect(new Set(scheduledPlatforms).size).toBe(scheduledPlatforms.length)
    expect(url.searchParams.get('limit')).toBe('400')
    expect(jobs[0].schedule).toBe('35 2 * * *')
  })

  it('contains only active data sources and excludes every dead or blocked source', () => {
    const activeSources = new Set<TraderSource>(SOURCES_WITH_DATA)
    const deadSources = new Set<TraderSource>(DEAD_BLOCKED_PLATFORMS)

    for (const platform of AVATAR_BACKFILL_SCHEDULE_PLATFORMS) {
      expect(activeSources.has(platform)).toBe(true)
      expect(deadSources.has(platform)).toBe(false)
    }
  })
})
