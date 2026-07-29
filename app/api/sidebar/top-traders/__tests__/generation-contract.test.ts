import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/sidebar/top-traders/route.ts'), 'utf8')

describe('sidebar top-trader generation contract', () => {
  it('binds source membership, rows, and cache to one sealed 90D generation', () => {
    expect(route).toContain('readSealedRankingGeneration(')
    expect(route).toContain('{ season: SIDEBAR_SEASON, sources: SIDEBAR_RANKING_SOURCES }')
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
    expect(route).toContain(".in('source', SIDEBAR_RANKING_SOURCES)")
    expect(route).toContain('createSealedRankingCacheEntry(sealedRead)')
    expect(route).toContain('parseSealedRankingCacheEntry')
  })

  it('rejects legacy cache values and incomplete non-empty reads', () => {
    expect(route).toContain('await del(cacheKey)')
    expect(route).toContain('sidebar cache did not satisfy the sealed publication contract')
    expect(route).toContain('sidebar cohort query returned no rows for a non-empty publication')
  })

  it('uses deterministic tie-breakers before the finite top-50 range', () => {
    expect(route).toContain(".order('arena_score', { ascending: false })")
    expect(route).toContain(".order('source', { ascending: true })")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
  })
})
