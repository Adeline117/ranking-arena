import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/sitemap-xml/route.ts'), 'utf8')

describe('trader sitemap ranking authority', () => {
  it('binds trader URLs to one sealed public generation', () => {
    expect(route.match(/readSealedRankingAuthorityGeneration\(/g)).toHaveLength(2)
    expect(route).toContain('const authoritySources = publication.proofs.map')
    expect(route).toContain(".in('source', authoritySources)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('uses proof counts and fails closed instead of indexing raw or partial rows', () => {
    expect(route).toContain(
      'publication.proofs.reduce((total, proof) => total + proof.published_rank_count, 0)'
    )
    expect(route).toContain('if (error || data === null)')
    expect(route).toContain('!isPublicRankingSourceAllowed(row.source)')
    expect(route).not.toContain("select('id', { count: 'exact', head: true })")
    expect(route).not.toContain('return 5000')
  })

  it('orders finite shards by a deterministic composite identity', () => {
    expect(route).toContain(".order('source', { ascending: true })")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
    expect(route).toContain('const identity = `${r.source ??')
  })
})
