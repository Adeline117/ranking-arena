import { traderCanonicalPath } from '../trader-url'

describe('traderCanonicalPath', () => {
  it('is the exchange-local id plus the platform', () => {
    expect(traderCanonicalPath({ sourceTraderId: '3355', source: 'okx_futures' })).toBe(
      '/trader/3355?platform=okx_futures'
    )
    expect(traderCanonicalPath({ sourceTraderId: '0xAbC', source: 'hyperliquid' })).toBe(
      '/trader/0xAbC?platform=hyperliquid'
    )
  })

  it('does not depend on the display handle', () => {
    const named = { handle: 'Top_Trader.1', sourceTraderId: '3355', source: 'okx_futures' }
    const renamed = { ...named, handle: 'Someone Else' }
    expect(traderCanonicalPath(named)).toBe(traderCanonicalPath(renamed))
  })

  it('encodes ids that are not path-safe', () => {
    expect(traderCanonicalPath({ sourceTraderId: 'a/b c', source: 'gmx' })).toBe(
      '/trader/a%2Fb%20c?platform=gmx'
    )
  })
})
