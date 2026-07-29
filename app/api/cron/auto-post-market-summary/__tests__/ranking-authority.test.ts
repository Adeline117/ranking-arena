import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(
  join(process.cwd(), 'app/api/cron/auto-post-market-summary/route.ts'),
  'utf8'
)

describe('daily market post ranking authority', () => {
  it('reads each ranking window from one sealed public generation', () => {
    expect(route).toContain('readSealedRankingAuthorityGeneration(')
    expect(route).toContain('const authoritySources = publication.proofs.map')
    expect(route).toContain(".in('source', authoritySources)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('fails closed on mutable source reads before inserting a public post', () => {
    expect(route).toContain('if (error || data === null)')
    expect(route).toContain('!isPublicRankingSourceAllowed(row.source)')
    expect(route).toContain('Market benchmark query failed:')
    expect(route.indexOf('const [prices, topPerformers, trendingTraders]')).toBeLessThan(
      route.indexOf(".from('posts')\n    .insert(")
    )
  })

  it('does not confuse another Arena Bot post with the daily summary', () => {
    expect(route).toContain(".ilike('title', 'Daily Market Pulse -%')")
    expect(route).toContain('if (existingPostError)')
    expect(route).toContain('Daily market post deduplication failed:')
  })

  it('uses a deterministic total order for both finite pages', () => {
    expect(route).toContain(".order('arena_score', { ascending: false })")
    expect(route).toContain(".order('source', { ascending: true })")
    expect(route).toContain(".order('source_trader_id', { ascending: true })")
    expect(route).toContain('.range(offset, offset + 2)')
  })

  it('bounds auth and every database phase inside the route budget', () => {
    expect(route).toContain('const workSignal = AbortSignal.timeout(45_000)')
    expect(route).toContain('await waitForSignal(')
    expect(route.match(/\.abortSignal\((workSignal|signal)\)/g)).toHaveLength(5)
    expect(route).toContain('throw new Error(`Could not create system user profile:')
    expect(route).toContain('{ safetyTimeoutMs: 55_000 }')
  })
})
