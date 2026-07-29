import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/share/rank-card/route.tsx'), 'utf8')

describe('rank card generation contract', () => {
  it('resolves public identity before authorizing one exact season cohort', () => {
    expect(route).toContain('parsePublicActiveRankingSource(requestedPlatform)')
    expect(route).toContain('resolveTrader(sb, { handle, platform })')
    expect(route).toContain('readSealedRankingGeneration(')
    expect(route).toContain('sources: [resolved.platform]')
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('derives the denominator from the same proof instead of a mutable count cache', () => {
    expect(route).toContain('sealedRead.publication.proofs[0].published_rank_count')
    expect(route).not.toContain("from('leaderboard_count_cache')")
    expect(route).not.toContain("from('trader_sources')")
  })

  it('fails closed on rank query errors', () => {
    expect(route).toContain('if (result.error)')
    expect(route).toContain('throw new Error(`rank card cohort query failed:')
  })
})
