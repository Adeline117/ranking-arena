import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8')

describe('linked traders ranking generation contract', () => {
  it('authorizes all public linked sources together before reading stats', () => {
    expect(route).toContain('filterPublicRankingSources(')
    expect(route).toContain('readSealedRankingGeneration(')
    expect(route).toContain("{ season: '90D', sources: proofSources }")
    expect(route).toContain(".in('source', proofSources)")
    expect(route).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('fails closed on a resolved rank query error', () => {
    expect(route).toContain('if (result.error)')
    expect(route).toContain('throw new Error(`linked trader rank query failed:')
    expect(route.match(/\.from\('leaderboard_ranks'\)/g)).toHaveLength(1)
  })
})
