import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/cron/weekly-digest/route.ts'), 'utf8')

describe('weekly email digest ranking authority', () => {
  it('builds top movers from one sealed public generation', () => {
    expect(route).toContain('filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)')
    expect(route).toContain('readSealedRankingGeneration(')
    expect(route).toContain("{ season: '7D', sources: WEEKLY_DIGEST_RANKING_SOURCES }")
    expect(route).toContain(".in('source', WEEKLY_DIGEST_RANKING_SOURCES)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('fails closed on every shared input before bulk email delivery', () => {
    expect(route).toContain('if (error || data === null)')
    expect(route).toContain('if (newTradersError)')
    expect(route).toContain('if (totalTrackedError)')
    expect(route).toContain('Failed to load digest follows:')
    expect(route).toContain('Failed to load digest activities for')
    expect(route).toContain('Failed to load digest subscriber emails:')
    expect(route.indexOf('const sealedMovers = await')).toBeLessThan(
      route.indexOf('const sendOne = async')
    )
  })

  it('uses deterministic ordering and excludes non-public activity sources', () => {
    expect(route).toContain(".order('roi', { ascending: false })")
    expect(route).toContain(".order('source', { ascending: true })")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
    expect(route).toContain('if (!isPublicRankingSourceAllowed(source)) continue')
  })
})
