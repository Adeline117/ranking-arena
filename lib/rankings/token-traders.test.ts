const mockReadSealedRankIdentities = jest.fn()

jest.mock('@/lib/rankings/read-sealed-rank-identities', () => ({
  readSealedRankIdentities: (...args: unknown[]) => mockReadSealedRankIdentities(...args),
}))

import {
  getTokenTraderRankingCacheKey,
  getTokenTraderRankings,
  mergeTokenRankingsWithProfiles,
} from './token-traders'

describe('getTokenTraderRankingCacheKey', () => {
  test('uses the aggregate-backed cache namespace', () => {
    expect(getTokenTraderRankingCacheKey('BTC', '90D', 25, 0)).toBe(
      'rankings:by-token:v3:BTC:90D:25:0'
    )
  })
})

describe('getTokenTraderRankings', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('binds profile enrichment to exact identities in one sealed period', async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: [
          {
            source: 'hyperliquid',
            source_trader_id: 'trader-1',
            token_pnl: '12.5',
            token_trade_count: '2',
            token_win_rate: '50',
            token_avg_pnl_pct: null,
            total_count: '1',
          },
        ],
        error: null,
      }),
      from: jest.fn(),
    }
    mockReadSealedRankIdentities.mockResolvedValue({
      value: [
        {
          source: 'hyperliquid',
          source_trader_id: 'trader-1',
          handle: 'Alice',
          avatar_url: null,
          arena_score: 80,
          roi: 20,
          pnl: 100,
        },
      ],
      publication: { state: 'sealed' },
      publicationIdentity: 'proof',
    })

    const result = await getTokenTraderRankings(client as never, 'BTC', '90D', 25, 0)

    expect(mockReadSealedRankIdentities).toHaveBeenCalledWith(client, '90D', [
      { source: 'hyperliquid', sourceTraderId: 'trader-1' },
    ])
    expect(result).toMatchObject({
      total: 1,
      traders: [
        {
          source: 'hyperliquid',
          source_trader_id: 'trader-1',
          handle: 'Alice',
          token_pnl: 12.5,
          total_pnl: 100,
        },
      ],
    })
  })

  test.each([
    {
      label: 'null data',
      data: null,
      message: 'returned no row array',
    },
    {
      label: 'quarantined source',
      data: [
        {
          source: 'okx_web3_solana',
          source_trader_id: 'hidden',
          token_pnl: 1,
          token_trade_count: 1,
          token_win_rate: 100,
          token_avg_pnl_pct: 1,
          total_count: 1,
        },
      ],
      message: 'invalid public identity',
    },
    {
      label: 'inconsistent total',
      data: [
        {
          source: 'bybit',
          source_trader_id: 'one',
          token_pnl: 2,
          token_trade_count: 1,
          token_win_rate: 100,
          token_avg_pnl_pct: 2,
          total_count: 2,
        },
        {
          source: 'bybit',
          source_trader_id: 'two',
          token_pnl: 1,
          token_trade_count: 1,
          token_win_rate: 100,
          token_avg_pnl_pct: 1,
          total_count: 3,
        },
      ],
      message: 'disagree on total_count',
    },
  ])('fails closed for $label', async ({ data, message }) => {
    const client = {
      rpc: jest.fn().mockResolvedValue({ data, error: null }),
      from: jest.fn(),
    }

    await expect(getTokenTraderRankings(client as never, 'BTC', '90D', 25, 0)).rejects.toThrow(
      message
    )
    expect(mockReadSealedRankIdentities).not.toHaveBeenCalled()
  })

  test('fails closed when sealed profile authority is unavailable', async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: [
          {
            source: 'bybit',
            source_trader_id: 'trader-1',
            token_pnl: 1,
            token_trade_count: 1,
            token_win_rate: 100,
            token_avg_pnl_pct: 1,
            total_count: 1,
          },
        ],
        error: null,
      }),
      from: jest.fn(),
    }
    mockReadSealedRankIdentities.mockRejectedValue(new Error('proof unavailable'))

    await expect(getTokenTraderRankings(client as never, 'BTC', '90D', 25, 0)).rejects.toThrow(
      'proof unavailable'
    )
  })
})

describe('mergeTokenRankingsWithProfiles', () => {
  test('preserves aggregate rank data and enriches matching trader profiles', () => {
    const result = mergeTokenRankingsWithProfiles(
      [
        {
          source: 'hyperliquid',
          source_trader_id: 'trader-1',
          token_pnl: '1234.56',
          token_trade_count: '42',
          token_win_rate: '61.9',
          token_avg_pnl_pct: null,
          total_count: '126',
        },
      ],
      [
        {
          source: 'hyperliquid',
          source_trader_id: 'trader-1',
          handle: 'Alice',
          avatar_url: 'https://example.com/alice.png',
          arena_score: 0,
          roi: 18.2,
          pnl: 9999,
        },
      ]
    )

    expect(result.total).toBe(126)
    expect(result.traders).toEqual([
      {
        source: 'hyperliquid',
        source_trader_id: 'trader-1',
        handle: 'Alice',
        avatar_url: 'https://example.com/alice.png',
        arena_score: 0,
        roi: 18.2,
        total_pnl: 9999,
        token_pnl: 1234.56,
        token_trade_count: 42,
        token_win_rate: 61.9,
        token_avg_pnl_pct: null,
      },
    ])
  })

  test('keeps a usable row when no leaderboard profile exists', () => {
    const result = mergeTokenRankingsWithProfiles(
      [
        {
          source: 'bybit',
          source_trader_id: 'trader-2',
          token_pnl: -10,
          token_trade_count: 2,
          token_win_rate: 0,
          token_avg_pnl_pct: -1.5,
          total_count: 1,
        },
      ],
      []
    )

    expect(result.traders[0]).toMatchObject({
      handle: null,
      arena_score: null,
      total_pnl: 0,
      token_win_rate: 0,
    })
  })
})
