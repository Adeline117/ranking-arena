import { traderCanonicalPath } from '../trader-url'

describe('traderCanonicalPath', () => {
  it('keeps a readable ASCII handle and always carries the platform', () => {
    expect(
      traderCanonicalPath({ handle: 'Top_Trader.1', sourceTraderId: '3355', source: 'okx_futures' })
    ).toBe('/trader/Top_Trader.1?platform=okx_futures')
  })

  it('falls back to the exchange-local id for non-ASCII, spaced, or missing handles', () => {
    for (const handle of ['交易员', 'Top Trader', '', null, undefined]) {
      expect(traderCanonicalPath({ handle, sourceTraderId: '0xAbC', source: 'hyperliquid' })).toBe(
        '/trader/0xAbC?platform=hyperliquid'
      )
    }
  })

  it('encodes ids that are not path-safe', () => {
    expect(traderCanonicalPath({ handle: null, sourceTraderId: 'a/b c', source: 'gmx' })).toBe(
      '/trader/a%2Fb%20c?platform=gmx'
    )
  })
})
