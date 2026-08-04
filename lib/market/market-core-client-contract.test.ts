import {
  createMarketCoreSnapshot,
  readMarketCoreResponse,
  readMarketExchangesResponse,
  type MarketCoreRow,
} from './market-core-client-contract'

const PAIRS = ['BTC-USD', 'ETH-USD'] as const
const rows: MarketCoreRow[] = [
  { symbol: 'BTC-USD', price: '100,000', changePct: '+1.25%', direction: 'up' },
]

function partialSnapshot() {
  return createMarketCoreSnapshot({
    rows,
    source: 'coingecko',
    cached: false,
    stale: false,
    requestedPairs: PAIRS,
    collectedAt: '2026-08-03T12:00:00.000Z',
  })
}

describe('market core client contract', () => {
  it('accepts an explicitly receipted partial provider result without filling missing rows', () => {
    const snapshot = partialSnapshot()

    expect(snapshot.rows).toEqual(rows)
    expect(snapshot).toMatchObject({
      requestedPairs: PAIRS,
      expectedCount: 2,
      foundCount: 1,
      missingPairs: ['ETH-USD'],
      partial: true,
    })
  })

  it.each([
    ['wrong request receipt', { requestedPairs: ['ETH-USD', 'BTC-USD'] }],
    ['wrong found count', { foundCount: 2 }],
    ['wrong missing receipt', { missingPairs: [] }],
    ['partial disguised as complete', { partial: false }],
  ])('rejects %s', (_label, change) => {
    expect(() => readMarketCoreResponse({ ...partialSnapshot(), ...change }, PAIRS)).toThrow()
  })

  it('rejects zero-filled and direction-inconsistent metrics', () => {
    expect(() =>
      readMarketCoreResponse(
        {
          ...partialSnapshot(),
          rows: [{ symbol: 'BTC-USD', price: '0', changePct: '-1.00%', direction: 'up' }],
        },
        PAIRS
      )
    ).toThrow()
  })

  it('rejects a healthy empty collection', () => {
    expect(() =>
      readMarketCoreResponse(
        {
          ...partialSnapshot(),
          rows: [],
          foundCount: 0,
          missingPairs: [...PAIRS],
        },
        PAIRS
      )
    ).toThrow()
  })

  it('treats a short but valid exchange list as explicit partial data', () => {
    expect(
      readMarketExchangesResponse([
        {
          id: 'binance',
          name: 'Binance',
          year_established: 2017,
          country: null,
          image: '',
          trust_score: 10,
          trust_score_rank: 1,
          trade_volume_24h_btc: 100_000,
        },
      ])
    ).toMatchObject({ partial: true, items: [{ id: 'binance' }] })
  })

  it('rejects malformed or healthy-empty exchange payloads', () => {
    expect(() => readMarketExchangesResponse([])).toThrow()
    expect(() => readMarketExchangesResponse([{ id: 'binance' }])).toThrow()
  })
})
