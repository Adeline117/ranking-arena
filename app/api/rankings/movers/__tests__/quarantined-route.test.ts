/**
 * @jest-environment node
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GET } from '../route'

const route = readFileSync(join(process.cwd(), 'app/api/rankings/movers/route.ts'), 'utf8')
const vercel = readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')
const rankingSection = readFileSync(
  join(process.cwd(), 'app/components/home/RankingSection.tsx'),
  'utf8'
)
const healthChecks = readFileSync(join(process.cwd(), 'lib/harness/health-checks.ts'), 'utf8')

describe('quarantined movers endpoint', () => {
  it('fails closed with an empty, non-cacheable response', async () => {
    const response = GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(
      'private, no-store, max-age=0, must-revalidate'
    )
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      risers: [],
      fallers: [],
      period: '90D',
      available: false,
      code: 'MOVERS_NOT_PUBLISHED',
      reason: 'snapshot_provenance_unverified',
      snapshotDate: null,
      compareDate: null,
    })
  })

  it('does not read unproven history, current ranks, or publication caches', () => {
    expect(route).not.toContain('getSupabaseAdmin')
    expect(route).not.toContain('checkRateLimit')
    expect(route).not.toContain("from('trader_daily_snapshots')")
    expect(route).not.toContain("from('leaderboard_ranks')")
    expect(route).not.toContain('getOrSetWithLock')
    expect(route).not.toContain('publicRankingCacheKey')
    expect(route).toContain("export const dynamic = 'force-dynamic'")
    expect(route).toContain('export const revalidate = 0')
    expect(vercel).not.toContain('/api/rankings/movers')
  })

  it('keeps the quarantined product out of the homepage request path', () => {
    expect(rankingSection).not.toContain('/api/rankings/movers')
    expect(rankingSection).not.toContain('LeaderboardChangelog')
    expect(healthChecks).toContain("expectTrueKey: 'available'")
    expect(healthChecks).toContain('Quarantined:')
  })
})
