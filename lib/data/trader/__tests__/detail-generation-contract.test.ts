import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('getTraderDetail ranking generation contract', () => {
  const source = readFileSync(join(process.cwd(), 'lib/data/trader/queries.ts'), 'utf8')
  const helperStart = source.indexOf('async function readSealedTraderRankRows')
  const leaderboardStart = source.indexOf('export async function getLeaderboard')
  const helper = source.slice(helperStart, leaderboardStart)

  it('authorizes each displayed period independently and binds its row to the cohort', () => {
    expect(helperStart).toBeGreaterThan(-1)
    expect(helper).toContain('TRADER_DETAIL_SEASONS.map')
    expect(helper).toContain('readSealedRankingGeneration(')
    expect(helper).toContain('.eq(LR.season_id, season)')
    expect(helper).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
    expect(helper).toContain('{ timeoutMs: SSR_HEAVY_QUERY_TIMEOUT_MS, signal: params.signal }')
  })
})

describe('resolveTrader ranking generation contract', () => {
  const source = readFileSync(join(process.cwd(), 'lib/data/trader/queries.ts'), 'utf8')
  const resolver = source.slice(source.indexOf('export async function resolveTrader'))

  it('binds both candidate scoring and legacy rank fallback to a sealed cohort', () => {
    expect(resolver.match(/readSealedRankingGeneration\(/g)).toHaveLength(2)
    expect(
      resolver.match(/\.filter\('rank_publication_id', 'eq', publication\.scoreCohortId\)/g)
    ).toHaveLength(2)
    expect(resolver).toContain('candidate.source === rankedCandidate[LR.source]')
    expect(resolver).toContain(
      'candidate.source_trader_id === rankedCandidate[LR.source_trader_id]'
    )
  })
})
