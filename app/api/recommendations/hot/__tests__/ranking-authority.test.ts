import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'lib/recommendations/hot-score.ts'), 'utf8')
const route = readFileSync(join(process.cwd(), 'app/api/recommendations/hot/route.ts'), 'utf8')

describe('hot recommendation ranking authority', () => {
  it('uses complete dynamic authority and binds the finite page before computing signals', () => {
    expect(source).toContain('const sealedRead = await readSealedRankingAuthorityGeneration(')
    expect(source).toContain(
      'const authoritySources = publication.proofs.map((proof) => proof.source)'
    )
    expect(source).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
    expect(source).toContain(".in('source', authoritySources)")
    expect(source.indexOf(".in('source', authoritySources)")).toBeLessThan(
      source.indexOf('.limit(300)')
    )
    expect(source).not.toContain('HOT_RANKING_SOURCES')
  })

  it('invalidates legacy unsealed recommendation cache entries', () => {
    expect(route).toContain("publicRankingCacheKey('recommendations:hot:sealed-v2')")
    expect(route).not.toContain("publicRankingCacheKey('recommendations:hot')")
  })
})
