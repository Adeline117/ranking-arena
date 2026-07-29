/**
 * @jest-environment node
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.env.LEADERBOARD_PUBLICATION_CONTRACT_ROOT ?? process.cwd()
const route = readFileSync(join(repoRoot, 'app/api/cron/compute-leaderboard/route.ts'), 'utf8')
const helpers = readFileSync(join(repoRoot, 'app/api/cron/compute-leaderboard/helpers.ts'), 'utf8')

describe('sealed leaderboard post-publication immutability', () => {
  it('never derives metrics by mutating already-published rank rows', () => {
    expect(route).not.toContain('deriveWinRateMDD')
    expect(helpers).not.toContain('deriveWinRateMDD')
    expect(helpers).not.toMatch(/\.from\(['"]leaderboard_ranks['"]\)/)
  })

  it('performs no rank-table write after the atomic generation is sealed', () => {
    const publication = route.indexOf('await publishAtomicRankGeneration({')
    expect(publication).toBeGreaterThan(-1)

    const postPublication = route.slice(publication)
    expect(postPublication).not.toMatch(
      /\.from\(['"]leaderboard_ranks['"]\)[\s\S]*?\.(?:insert|upsert|update|delete)\(/
    )
  })
})
