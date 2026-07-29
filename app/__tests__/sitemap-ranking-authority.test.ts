import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sitemap = readFileSync(join(process.cwd(), 'app/sitemap.ts'), 'utf8')

describe('Next sitemap ranking authority', () => {
  it('reads each trader shard from one sealed public generation', () => {
    expect(sitemap).toContain('filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)')
    expect(sitemap).toContain('readSealedRankingGeneration(')
    expect(sitemap).toContain("{ season: '90D', sources: SITEMAP_RANKING_SOURCES }")
    expect(sitemap).toContain(".in('source', SITEMAP_RANKING_SOURCES)")
    expect(sitemap).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('fails closed and orders finite pages by composite trader identity', () => {
    expect(sitemap).toContain('if (error || data === null)')
    expect(sitemap).toContain('!isPublicRankingSourceAllowed(row.source)')
    expect(sitemap).toContain(".order('source', { ascending: true })")
    expect(sitemap).toContain(".order('source_trader_id', { ascending: true })")
    expect(sitemap).not.toContain('.limit(49000)')
    expect(sitemap).not.toContain('getAllTraders')
  })

  it('emits source-scoped canonical trader URLs', () => {
    expect(sitemap).toContain('?platform=${encodeURIComponent(trader.source)}')
    expect(sitemap).toContain('const canonicalIdentity = `${row.source}:${handle}`')
  })
})
