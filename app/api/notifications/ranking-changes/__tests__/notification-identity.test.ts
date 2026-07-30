import { watchedRankingChangeLink, watchedRankingChangeReference } from '../notification-identity'

describe('watched ranking-change notification identity', () => {
  it('separates source, trader, day, and exact movement', () => {
    const first = watchedRankingChangeReference('shared/id', 'bybit/futures', '2026-07-29', 20, 5)
    const replay = watchedRankingChangeReference('shared/id', 'bybit/futures', '2026-07-29', 20, 5)
    const laterMove = watchedRankingChangeReference(
      'shared/id',
      'bybit/futures',
      '2026-07-29',
      20,
      4
    )
    const otherSource = watchedRankingChangeReference('shared/id', 'binance', '2026-07-29', 20, 5)

    expect(replay).toBe(first)
    expect(new Set([first, laterMove, otherSource]).size).toBe(3)
    expect(first).toBe('watched_rank_change:bybit%2Ffutures:shared%2Fid:2026-07-29:20:5')
  })

  it('encodes both path identity and source query value', () => {
    expect(watchedRankingChangeLink('shared/id', 'bybit/futures')).toBe(
      '/trader/shared%2Fid?platform=bybit%2Ffutures'
    )
  })
})
