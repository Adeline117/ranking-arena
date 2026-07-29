import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/sidebar/top-traders/route.ts'), 'utf8')

describe('sidebar top trader ranking authority', () => {
  it('uses a new cache namespace populated only from a sealed public generation', () => {
    expect(route).toContain("publicRankingCacheKey('sidebar:top-traders-sealed-v3:90D')")
    expect(route).toContain('readSealedRankingAuthorityGeneration(')
    expect(route).toContain('const authoritySources = publication.proofs.map')
    expect(route).toContain(".in('source', authoritySources)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
    expect(route).toContain('createSealedRankingCacheEntry(sealedRead)')
    expect(route).toContain('parseSealedRankingCacheEntry<{ traders: unknown[] }>')
  })

  it('fails closed before caching malformed or cross-boundary rows', () => {
    expect(route).toContain('if (snapErr || snapData === null)')
    expect(route).toContain('!isPublicRankingSourceAllowed(row.source)')
    expect(route).toContain('sidebar ranking query crossed the public source boundary')
  })

  it('uses a deterministic finite top-50 order', () => {
    expect(route).toContain(".order('arena_score', { ascending: false })")
    expect(route).toContain(".order('source', { ascending: true })")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
    expect(route).toContain('.limit(50)')
  })
})
