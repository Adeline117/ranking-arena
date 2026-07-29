import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const page = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

describe('wrapped rank generation contract', () => {
  it('binds the trader rank and global denominator to one sealed generation', () => {
    expect(page).toContain('readSealedRankingAuthorityGeneration(')
    expect(page).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
    expect(page).toContain('sum + proof.published_rank_count')
  })

  it('fails closed without a separate unfenced max-rank read', () => {
    expect(page).toContain('if (rankResult.error)')
    expect(page).toContain('throw new Error(`wrapped rank query failed:')
    expect(page.match(/\.from\('leaderboard_ranks'\)/g)).toHaveLength(1)
    expect(page).not.toContain("order('rank', { ascending: false")
  })
})
