import {
  createMarketSpotSnapshot,
  marketSpotReceiptHeaders,
  readCoinGeckoSpotResponse,
  readMarketSpotResponse,
  type MarketSpotCoin,
} from './market-spot-client-contract'

const completeCoin: MarketSpotCoin = {
  id: 'bitcoin',
  symbol: 'BTC',
  name: 'Bitcoin',
  image: null,
  price: 100_000,
  change1h: null,
  change24h: 1,
  change7d: null,
  high24h: 101_000,
  low24h: 99_000,
  volume24h: 1_000_000,
  marketCap: 2_000_000,
  rank: 1,
}

function snapshot() {
  return createMarketSpotSnapshot({
    coins: [completeCoin],
    source: 'coingecko',
    providerLimit: 100,
    collectedAt: '2026-08-03T12:00:00.000Z',
  })
}

function headers(change: Record<string, string> = {}) {
  return new Headers({ ...marketSpotReceiptHeaders(snapshot()), ...change })
}

describe('market spot client contract', () => {
  it('requires and verifies provider coverage headers while retaining real partial rows', () => {
    expect(readMarketSpotResponse([completeCoin], headers())).toEqual(snapshot())
    expect(snapshot()).toMatchObject({
      requestedCount: 100,
      providerLimit: 100,
      foundCount: 1,
      completeCount: 1,
      partial: true,
    })
  })

  it.each([
    ['wrong found receipt', { 'X-Market-Found-Count': '2' }],
    ['wrong complete receipt', { 'X-Market-Complete-Count': '0' }],
    ['partial disguised as complete', { 'X-Market-Partial': 'false' }],
    ['invalid collection time', { 'X-Market-Collected-At': 'now' }],
  ])('rejects %s', (_label, change) => {
    expect(() => readMarketSpotResponse([completeCoin], headers(change))).toThrow()
  })

  it('rejects missing receipts and healthy empty arrays', () => {
    expect(() => readMarketSpotResponse([completeCoin], new Headers())).toThrow()
    expect(() => readMarketSpotResponse([], headers())).toThrow()
  })

  it('preserves unavailable metrics as null instead of fabricating zeroes', () => {
    const result = readCoinGeckoSpotResponse(
      [
        {
          id: 'bitcoin',
          symbol: 'btc',
          name: 'Bitcoin',
          image: null,
          current_price: 100_000,
          price_change_percentage_24h: 1,
          high_24h: null,
          low_24h: null,
          total_volume: null,
          market_cap: null,
          market_cap_rank: null,
        },
      ],
      '2026-08-03T12:00:00.000Z'
    )

    expect(result.coins[0]).toMatchObject({
      high24h: null,
      low24h: null,
      volume24h: null,
      marketCap: null,
      rank: null,
    })
    expect(result.completeCount).toBe(0)
    expect(result.partial).toBe(true)
  })

  it('rejects provider rows with unusable prices instead of converting them to zero', () => {
    expect(() =>
      readCoinGeckoSpotResponse([
        {
          id: 'bitcoin',
          symbol: 'btc',
          name: 'Bitcoin',
          current_price: null,
          price_change_percentage_24h: 1,
        },
      ])
    ).toThrow()
  })
})
