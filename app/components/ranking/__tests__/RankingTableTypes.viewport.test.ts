import { MOBILE_CARD_MEDIA_QUERY, getInitialRankingViewMode } from '../RankingTableTypes'

function matchViewport(width: number) {
  return (query: string) => ({
    matches: query === MOBILE_CARD_MEDIA_QUERY && width <= 767,
  })
}

describe('ranking first-paint viewport mode', () => {
  it.each([
    [320, 'card'],
    [375, 'card'],
    [768, 'table'],
    [1440, 'table'],
  ] as const)('uses %ipx viewport as %s mode before effects run', (width, expected) => {
    expect(getInitialRankingViewMode(matchViewport(width))).toBe(expected)
  })

  it('falls back to the desktop table when matchMedia is unavailable', () => {
    expect(getInitialRankingViewMode(null)).toBe('table')
  })
})
