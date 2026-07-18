import { traderEventLink, traderEventReference } from '../notification-identity'

describe('broadcast trader event notification identity', () => {
  it('separates the same raw id across sources and event slots', () => {
    const bybit = traderEventReference('shared/id', 'bybit/futures', 'metric')
    const binance = traderEventReference('shared/id', 'binance', 'metric')
    const position = traderEventReference('shared/id', 'bybit/futures', 'position')

    expect(new Set([bybit, binance, position]).size).toBe(3)
    expect(bybit).toBe('trader_event:bybit%2Ffutures:shared%2Fid:metric')
  })

  it('encodes both path identity and source query value', () => {
    expect(traderEventLink('shared/id', 'bybit/futures')).toBe(
      '/trader/shared%2Fid?platform=bybit%2Ffutures'
    )
    expect(traderEventLink('shared/id', '')).toBe('/trader/shared%2Fid')
  })
})
