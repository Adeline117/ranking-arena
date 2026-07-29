import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/broadcast-trader-events/route.ts'),
  'utf8'
)

describe('broadcast ranking notification authority', () => {
  it('reads current ranks from one sealed public generation', () => {
    expect(route).toContain('filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)')
    expect(route).toContain('readSealedRankingGeneration(')
    expect(route).toContain("{ season: '90D', sources: EVENT_RANKING_SOURCES }")
    expect(route).toContain(".in('source', EVENT_RANKING_SOURCES)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('fails closed on a source-boundary breach before notification fan-out', () => {
    expect(route).toContain('lr.some((row) => !isPublicRankingSourceAllowed(row.source))')
    expect(route).toContain(
      "throw new Error('broadcast ranking query crossed the public source boundary')"
    )
    expect(route.indexOf('const sealedEventRows = await')).toBeLessThan(
      route.indexOf("type: 'ranking_change'")
    )
  })

  it('paginates the sealed cohort in deterministic composite order', () => {
    expect(route).toContain(".order('source', { ascending: true })")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
  })
})
