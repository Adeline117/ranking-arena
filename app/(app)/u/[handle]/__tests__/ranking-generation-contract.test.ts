import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const page = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

describe('public user profile ranking metadata contract', () => {
  it('only reads a claimed trader from a stable sealed public generation', () => {
    expect(page).toContain('filterPublicRankingSources([publicData.verified_trader_source])')
    expect(page).toContain('readSealedRankingGeneration(')
    expect(page).toContain("{ season: '90D', sources: [publicSource] }")
    expect(page).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
  })

  it('fails closed on a resolved rank query error', () => {
    expect(page).toContain('if (result.error)')
    expect(page).toContain('throw new Error(`profile ranking metadata query failed:')
    expect(page.match(/\.from\('leaderboard_ranks'\)/g)).toHaveLength(1)
  })
})
