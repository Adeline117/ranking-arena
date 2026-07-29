import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const page = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

describe('exchange ranking page generation contract', () => {
  it('authorizes the page against one stable sealed source generation', () => {
    expect(page).toContain('readSealedRankingGeneration(')
    expect(page).toContain("{ season: '90D', sources: [publicSource] }")
    expect(page).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
    expect(page).toContain('publication.proofs[0].published_rank_count')
  })

  it('fails closed and never combines rows with a generic cross-generation count', () => {
    expect(page).toContain('if (topResult.error)')
    expect(page).toContain('throw new Error(`exchange ranking query failed:')
    expect(page).not.toContain("select('*', { count: 'estimated', head: true })")
    expect(page.match(/\.from\('leaderboard_ranks'\)/g)).toHaveLength(1)
  })
})
