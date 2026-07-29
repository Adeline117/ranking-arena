import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/cron/auto-post-twitter/route.ts'), 'utf8')

describe('Twitter ranking publication authority', () => {
  it('builds the external post from one sealed public generation', () => {
    expect(route).toContain('readSealedRankingAuthorityGeneration(')
    expect(route).toContain('const authoritySources = publication.proofs.map')
    expect(route).toContain(".in('source', authoritySources)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('fails closed before posting on query or source-boundary drift', () => {
    expect(route).toContain('if (error || data === null)')
    expect(route).toContain('!isPublicRankingSourceAllowed(row.source)')
    expect(route).toContain(
      "throw new Error('Twitter ranking query crossed the public source boundary')"
    )
    expect(route.indexOf('const sealedRead = await')).toBeLessThan(
      route.indexOf('postTweet(content)')
    )
  })

  it('uses a deterministic total order for the top-five page', () => {
    expect(route).toContain(".order('arena_score', { ascending: false })")
    expect(route).toContain(".order('source', { ascending: true })")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
    expect(route).toContain('.limit(5)')
  })
})
