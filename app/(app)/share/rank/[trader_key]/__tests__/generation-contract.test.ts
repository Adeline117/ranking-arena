import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const page = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

describe('legacy share rank generation contract', () => {
  it('reads the trader row and global denominator through one sealed generation', () => {
    expect(page).toContain('readSealedRankingGeneration(')
    expect(page).toContain('sources: WRAPPED_PROOF_SOURCES')
    expect(page).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
    expect(page).toContain('sum + proof.published_rank_count')
  })

  it('fails closed and never performs a separate unfenced max-rank query', () => {
    expect(page).toContain('if (rankResult.error)')
    expect(page).toContain('throw new Error(`share rank query failed:')
    expect(page.match(/\.from\('leaderboard_ranks'\)/g)).toHaveLength(1)
    expect(page).not.toContain("order('rank', { ascending: false")
  })
})
