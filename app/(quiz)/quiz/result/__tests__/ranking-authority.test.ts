import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const page = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

describe('quiz result ranking authority', () => {
  it('reads recommendations from one stable sealed public generation', () => {
    expect(page).toContain('filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)')
    expect(page).toContain('readSealedRankingGeneration(')
    expect(page).toContain("{ season: '90D', sources: QUIZ_RANKING_SOURCES }")
    expect(page).toContain(".in('source', QUIZ_RANKING_SOURCES)")
    expect(page).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('fails closed on query or source-boundary drift', () => {
    expect(page).toContain('if (error || data === null)')
    expect(page).toContain('throw new Error(`quiz ranking query failed:')
    expect(page).toContain('!isPublicRankingSourceAllowed(row.source)')
    expect(page).toContain(
      "throw new Error('quiz ranking query crossed the public source boundary')"
    )
  })

  it('uses a deterministic total order for the finite recommendation page', () => {
    expect(page).toContain('.order(query.orderBy, { ascending: query.ascending })')
    expect(page).toContain(".order('source', { ascending: true })")
    expect(page).toContain(".order('source_trader_id', { ascending: true })")
    expect(page).toContain('.limit(3)')
  })
})
