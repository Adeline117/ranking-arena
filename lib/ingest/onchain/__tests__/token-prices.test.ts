import { bestPricesFromPairs, unrealizedFromHoldings, type DexPair } from '../token-prices'
import type { PerTokenPnl } from '../pnl-accounting'

const perTok = (over: Partial<PerTokenPnl>): PerTokenPnl => ({
  token: 'x',
  realizedPnlUsd: 0,
  holding: 0,
  costBasisUsd: 0,
  buyVolumeUsd: 0,
  sellVolumeUsd: 0,
  swaps: 0,
  closedPositions: 0,
  winningPositions: 0,
  ...over,
})

describe('bestPricesFromPairs', () => {
  it('picks the highest-liquidity pair per token', () => {
    const pairs: DexPair[] = [
      { baseToken: { address: '0xAAA' }, priceUsd: '1.5', liquidity: { usd: 1000 } },
      { baseToken: { address: '0xAAA' }, priceUsd: '1.6', liquidity: { usd: 9000 } }, // deeper
      { baseToken: { address: '0xBBB' }, priceUsd: '0.02', liquidity: { usd: 500 } },
    ]
    const m = bestPricesFromPairs(pairs)
    expect(m.get('0xaaa')).toBe(1.6) // deeper pool wins, addr lowercased
    expect(m.get('0xbbb')).toBe(0.02)
  })

  it('skips pairs with no/zero/invalid price', () => {
    const m = bestPricesFromPairs([
      { baseToken: { address: '0xC' }, priceUsd: '0' },
      { baseToken: { address: '0xD' }, priceUsd: 'abc' },
      { baseToken: {}, priceUsd: '5' },
    ])
    expect(m.size).toBe(0)
  })
})

describe('unrealizedFromHoldings', () => {
  it('values held tokens; unpriced bags excluded (no guessing)', () => {
    const per = [
      perTok({ token: '0xAAA', holding: 100, costBasisUsd: 100 }), // priced 1.6 → value 160, +60
      perTok({ token: '0xBBB', holding: 50, costBasisUsd: 200 }), // no price → unpriced
      perTok({ token: '0xCCC', holding: 0, costBasisUsd: 0 }), // closed → skipped
    ]
    const prices = new Map([['0xaaa', 1.6]])
    const r = unrealizedFromHoldings(per, prices)
    expect(r.unrealizedUsd).toBeCloseTo(60, 6)
    expect(r.heldValueUsd).toBeCloseTo(160, 6)
    expect(r.pricedTokens).toBe(1)
    expect(r.unpricedTokens).toBe(1)
  })

  it('negative unrealized when the bag is down', () => {
    const per = [perTok({ token: '0xE', holding: 1000, costBasisUsd: 500 })]
    const r = unrealizedFromHoldings(per, new Map([['0xe', 0.1]])) // value 100 vs cost 500
    expect(r.unrealizedUsd).toBeCloseTo(-400, 6)
  })
})
