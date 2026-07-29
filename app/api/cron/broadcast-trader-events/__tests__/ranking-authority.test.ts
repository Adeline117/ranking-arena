import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/broadcast-trader-events/route.ts'),
  'utf8'
)

describe('broadcast ranking notification authority', () => {
  it('reads current ranks from one sealed public generation', () => {
    expect(route).toContain('readSealedRankingAuthorityGeneration(')
    expect(route).toContain('const authoritySources = publication.proofs.map')
    expect(route).toContain(".in('source', authoritySources)")
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
