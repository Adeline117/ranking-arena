import {
  bestPricesFromPairs,
  fetchTokenInfo,
  tokenAddressKey,
  unrealizedFromHoldings,
  type DexPair,
} from '../token-prices'
import type { PerTokenPnl } from '../pnl-accounting'

const SOL_MINT = 'ToKenMint1111111111111111111111111111111111'
const SOL_MINT_CASE_VARIANT = SOL_MINT.toLowerCase()

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
  it('picks the highest-liquidity BSC pair per normalized contract', () => {
    const pairs: DexPair[] = [
      {
        chainId: 'bsc',
        baseToken: { address: '0xAAA' },
        priceUsd: '1.5',
        liquidity: { usd: 1000 },
      },
      {
        chainId: 'bsc',
        baseToken: { address: '0xaaa' },
        priceUsd: '1.6',
        liquidity: { usd: 9000 },
      }, // deeper
      {
        chainId: 'bsc',
        baseToken: { address: '0xBBB' },
        priceUsd: '0.02',
        liquidity: { usd: 500 },
      },
    ]
    const m = bestPricesFromPairs(pairs, 'bsc')
    expect(m.get('0xaaa')).toBe(1.6) // deeper pool wins, addr lowercased
    expect(m.get('0xbbb')).toBe(0.02)
  })

  it('keeps case-distinct Solana mints separate and filters other chains', () => {
    const m = bestPricesFromPairs(
      [
        {
          chainId: 'solana',
          baseToken: { address: SOL_MINT },
          priceUsd: '2',
          liquidity: { usd: 100 },
        },
        {
          chainId: 'solana',
          baseToken: { address: SOL_MINT },
          priceUsd: '3',
          liquidity: { usd: 1000 },
        },
        {
          chainId: 'solana',
          baseToken: { address: SOL_MINT_CASE_VARIANT },
          priceUsd: '7',
          liquidity: { usd: 500 },
        },
        {
          chainId: 'bsc',
          baseToken: { address: SOL_MINT },
          priceUsd: '999',
          liquidity: { usd: 999_999 },
        },
      ],
      'solana'
    )

    expect(m).toEqual(
      new Map([
        [SOL_MINT, 3],
        [SOL_MINT_CASE_VARIANT, 7],
      ])
    )
  })

  it('skips pairs with no/zero/invalid price', () => {
    const m = bestPricesFromPairs(
      [
        { chainId: 'bsc', baseToken: { address: '0xC' }, priceUsd: '0' },
        { chainId: 'bsc', baseToken: { address: '0xD' }, priceUsd: 'abc' },
        { chainId: 'bsc', baseToken: {}, priceUsd: '5' },
      ],
      'bsc'
    )
    expect(m.size).toBe(0)
  })
})

describe('tokenAddressKey', () => {
  it('preserves Solana base58 casing and normalizes EVM checksum casing', () => {
    expect(tokenAddressKey(` ${SOL_MINT} `, 'solana')).toBe(SOL_MINT)
    expect(tokenAddressKey(SOL_MINT_CASE_VARIANT, 'solana')).not.toBe(SOL_MINT)
    expect(tokenAddressKey(' 0xAaBb ', 'bsc')).toBe('0xaabb')
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
    const r = unrealizedFromHoldings(per, prices, 'bsc')
    expect(r.unrealizedUsd).toBeCloseTo(60, 6)
    expect(r.heldValueUsd).toBeCloseTo(160, 6)
    expect(r.pricedTokens).toBe(1)
    expect(r.unpricedTokens).toBe(1)
  })

  it('negative unrealized when the bag is down', () => {
    const per = [perTok({ token: '0xE', holding: 1000, costBasisUsd: 500 })]
    const r = unrealizedFromHoldings(per, new Map([['0xe', 0.1]]), 'bsc') // value 100 vs cost 500
    expect(r.unrealizedUsd).toBeCloseTo(-400, 6)
  })

  it('requires an exact Solana mint but keeps BSC matching case-insensitive', () => {
    const held = [perTok({ token: SOL_MINT, holding: 10, costBasisUsd: 5 })]

    expect(
      unrealizedFromHoldings(held, new Map([[SOL_MINT_CASE_VARIANT, 2]]), 'solana')
    ).toMatchObject({ pricedTokens: 0, unpricedTokens: 1, unrealizedUsd: 0 })
    expect(unrealizedFromHoldings(held, new Map([[SOL_MINT, 2]]), 'solana')).toMatchObject({
      pricedTokens: 1,
      unpricedTokens: 0,
      unrealizedUsd: 15,
    })
    expect(
      unrealizedFromHoldings(
        [perTok({ token: '0xAaBb', holding: 10, costBasisUsd: 5 })],
        new Map([['0xaabb', 2]]),
        'bsc'
      )
    ).toMatchObject({ pricedTokens: 1, unpricedTokens: 0, unrealizedUsd: 15 })
  })
})

describe('fetchTokenInfo', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    if (originalFetch === undefined) Reflect.deleteProperty(global, 'fetch')
    else global.fetch = originalFetch
  })

  function mockDexscreener(pairs: DexPair[]) {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => pairs,
    } as Response)
    Object.defineProperty(global, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    })
    return fetchMock
  }

  it('uses the chain-scoped Solana endpoint and preserves case-distinct requests', async () => {
    const fetchMock = mockDexscreener([
      {
        chainId: 'solana',
        baseToken: { address: SOL_MINT, symbol: 'TOK' },
        priceUsd: '2',
        liquidity: { usd: 100 },
      },
      {
        chainId: 'solana',
        baseToken: { address: SOL_MINT, symbol: 'TOK' },
        priceUsd: '3',
        liquidity: { usd: 1000 },
      },
      {
        chainId: 'solana',
        baseToken: { address: SOL_MINT_CASE_VARIANT, symbol: 'OTHER' },
        priceUsd: '7',
        liquidity: { usd: 500 },
      },
    ])

    const info = await fetchTokenInfo([SOL_MINT, SOL_MINT, SOL_MINT_CASE_VARIANT], {
      chain: 'solana',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT},${SOL_MINT_CASE_VARIANT}`
    )
    expect(info.get(SOL_MINT)?.priceUsd).toBe(3)
    expect(info.get(SOL_MINT_CASE_VARIANT)?.priceUsd).toBe(7)
  })

  it('rejects wrong-case Solana, wrong-chain, and non-requested response identities', async () => {
    mockDexscreener([
      {
        chainId: 'solana',
        baseToken: { address: SOL_MINT_CASE_VARIANT },
        priceUsd: '2',
        liquidity: { usd: 1000 },
      },
      {
        chainId: 'bsc',
        baseToken: { address: SOL_MINT },
        priceUsd: '999',
        liquidity: { usd: 999_999 },
      },
      {
        chainId: 'solana',
        baseToken: { address: 'DifferentMint111111111111111111111111111111' },
        priceUsd: '4',
        liquidity: { usd: 500 },
      },
    ])

    const info = await fetchTokenInfo([SOL_MINT], { chain: 'solana' })

    expect(info.size).toBe(0)
  })

  it('lowercases and deduplicates BSC contracts while accepting checksum responses', async () => {
    const fetchMock = mockDexscreener([
      {
        chainId: 'bsc',
        baseToken: { address: '0xAaBb', symbol: 'BSC' },
        priceUsd: '5',
        liquidity: { usd: 1000 },
      },
    ])

    const info = await fetchTokenInfo(['0xAaBb', '0xaabb'], { chain: 'bsc' })

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.dexscreener.com/tokens/v1/bsc/0xaabb')
    expect(info.get('0xaabb')?.priceUsd).toBe(5)
    expect(info.size).toBe(1)
  })

  it('keeps Dexscreener batches at 30 token identities', async () => {
    const fetchMock = mockDexscreener([])
    const addresses = Array.from({ length: 31 }, (_, i) => `Mint${String(i).padStart(2, '0')}`)

    await fetchTokenInfo(addresses, { chain: 'solana' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const requestSizes = fetchMock.mock.calls.map(
      ([url]) => new URL(String(url)).pathname.split('/').at(-1)?.split(',').length
    )
    expect(requestSizes).toEqual([30, 1])
  })
})
