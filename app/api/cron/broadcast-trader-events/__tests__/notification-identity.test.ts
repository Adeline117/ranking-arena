import { traderEventLink, traderEventReference } from '../notification-identity'

describe('broadcast trader event notification identity', () => {
  it('separates the same raw id across sources and event slots', () => {
    const bybit = traderEventReference('shared/id', 'bybit/futures', 'metric', '2026-07-29')
    const replay = traderEventReference('shared/id', 'bybit/futures', 'metric', '2026-07-29')
    const nextDay = traderEventReference('shared/id', 'bybit/futures', 'metric', '2026-07-30')
    const binance = traderEventReference('shared/id', 'binance', 'metric', '2026-07-29')
    const position = traderEventReference('shared/id', 'bybit/futures', 'position', '2026-07-29')

    expect(replay).toBe(bybit)
    expect(new Set([bybit, nextDay, binance, position]).size).toBe(4)
    expect(bybit).toBe('trader_event:bybit%2Ffutures:shared%2Fid:metric:2026-07-29')
  })

  it('encodes both path identity and source query value', () => {
    expect(traderEventLink('shared/id', 'bybit/futures')).toBe(
      '/trader/shared%2Fid?platform=bybit%2Ffutures'
    )
    expect(traderEventLink('shared/id', '')).toBe('/trader/shared%2Fid')
  })
})
