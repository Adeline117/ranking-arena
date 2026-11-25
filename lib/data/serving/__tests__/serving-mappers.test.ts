/**
 * Serving-layer mapper tests (spec §2.4/§6) — RPC jsonb → frontend contracts.
 */

const mockFetchPublicProfileRankingRows = jest.fn()
jest.mock('@/lib/data/trader/public-profile-ranking', () => ({
  PUBLIC_PROFILE_RANKING_PERIODS: ['7D', '30D', '90D'],
  fetchPublicProfileRankingRows: (...args: unknown[]) => mockFetchPublicProfileRankingRows(...args),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import { projectBoardExtras } from '../board-extras'
import { getFirstScreen, getPublicFirstScreen } from '../first-screen'
import { isFresh, tfToInt } from '../core'
import { getSourceCapabilities } from '../capabilities'

function rpcClient(data: unknown, error: unknown = null): SupabaseClient {
  return { rpc: jest.fn().mockResolvedValue({ data, error }) } as unknown as SupabaseClient
}

describe('projectBoardExtras', () => {
  it('projects the bitget UTA board row into superset keys', () => {
    const raw = {
      traderUid: 'beb24d718eb23b54ac91',
      followCount: 72,
      itemVoList: [
        { showColumnCode: 'profit_rate', comparedValue: '305513.07' },
        { showColumnCode: 'total_income', comparedValue: '7350.77' },
        { showColumnCode: 'total_follow_profit', comparedValue: '1209.79' },
        { showColumnCode: 'max_retracement', comparedValue: '4.83' },
        { showColumnCode: 'winning_rate', comparedValue: '58.33' },
      ],
      // The real board shape; entries no longer store it and it was never an array.
      klineProfit: { rows: [{ amount: '-14.76', dataTime: 1787760000000 }] },
    }
    expect(projectBoardExtras('bitget_futures', raw)).toEqual({
      win_rate: 58.33,
      mdd: 4.83,
      copier_pnl: 1209.79,
      copier_count: 72,
    })
  })

  it('drops NULL fields entirely (NULL-collapse, no dashes)', () => {
    const extras = projectBoardExtras('bitget_futures', { traderUid: 'x', followCount: 5 })
    expect(extras).toEqual({ copier_count: 5 })
    expect('mdd' in extras).toBe(false)
  })

  it('falls back to generic key scan for unknown sources', () => {
    expect(
      projectBoardExtras('some_future_exchange', { winRate: 61.2, maxDrawdown: 9.1, copiers: 14 })
    ).toEqual({ win_rate: 61.2, mdd: 9.1, copier_count: 14 })
  })

  it('returns {} for junk input', () => {
    expect(projectBoardExtras('bitget_futures', null)).toEqual({})
    expect(projectBoardExtras('bitget_futures', undefined)).toEqual({})
  })
})

describe('getPublicFirstScreen', () => {
  const rpcPayload = {
    source: 'bitget_futures',
    exchangeTraderId: 'beb24d718eb23b54ac91',
    nickname: 'AI-HUB',
    avatarMirrorUrl: null,
    avatarOriginUrl: 'https://qrc.bgstatic.com/otc/images/a.png',
    walletAddress: null,
    traderKind: 'human',
    botStrategy: null,
    currency: 'USDT',
    entries: [
      {
        timeframe: 30,
        rank: 1,
        headlineRoi: 305513.07,
        headlinePnl: '7350.77',
        headlineWinRate: 58.33,
        currency: 'USDT',
        extras: { followCount: 72, itemVoList: [] },
        asOf: '2026-06-10T12:00:00Z',
      },
      // timeframe 0 (inception) must never surface on the first screen
      {
        timeframe: 0,
        rank: 9,
        headlineRoi: 1,
        headlinePnl: null,
        headlineWinRate: null,
        currency: null,
        extras: {},
        asOf: '2026-06-10T12:00:00Z',
      },
    ],
  }

  beforeEach(() => {
    mockFetchPublicProfileRankingRows.mockResolvedValue({
      rows: [],
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_cohort_unavailable',
    })
  })

  it('keeps raw RPC rank/ROI/PnL unknown when the sealed cohort is unavailable', async () => {
    const fs = await getPublicFirstScreen(
      rpcClient(rpcPayload),
      'bitget_futures',
      'beb24d718eb23b54ac91'
    )
    expect(fs).not.toBeNull()
    expect(fs!.nickname).toBe('AI-HUB')
    // No mirror and a proxy-required origin → client renders its local fallback.
    expect(fs!.avatarSrc).toBeNull()
    expect(fs!.entries).toHaveLength(1)
    expect(fs!.entries[0]).toMatchObject({
      rank: null,
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_cohort_unavailable',
      headlineRoi: null,
      headlinePnl: null,
    })
    expect(JSON.stringify(fs!.entries[0])).not.toContain('305513.07')
    expect(JSON.stringify(fs!.entries[0])).not.toContain('7350.77')
    expect(fs!.entries[0].extras.copier_count).toBe(72)
    expect(fs!.entries[0].provenance).toEqual({
      source: 'bitget_futures',
      asOf: '2026-06-10T12:00:00Z',
    })
  })

  it('uses only sealed rank and ROI, while keeping PnL null without a public currency proof', async () => {
    mockFetchPublicProfileRankingRows.mockResolvedValueOnce({
      rows: [
        {
          season_id: '30D',
          source: 'bitget_futures',
          source_trader_id: 'beb24d718eb23b54ac91',
          rank: 5,
          roi: 12.34,
          pnl: 999999,
        },
      ],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_period_not_published',
    })

    const fs = await getFirstScreen(rpcClient(rpcPayload), 'bitget_futures', 'beb24d718eb23b54ac91')

    expect(fs?.entries[0]).toMatchObject({
      rank: 5,
      rankingVisibility: 'verified',
      rankingVisibilityReason: null,
      headlineRoi: 12.34,
      headlinePnl: null,
    })
    expect(mockFetchPublicProfileRankingRows).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: 'bitget_futures',
        sourceTraderId: 'beb24d718eb23b54ac91',
        periods: ['7D', '30D', '90D'],
      })
    )
  })

  it('fails closed when the arena RPC identity disagrees with the sealed cohort scope', async () => {
    mockFetchPublicProfileRankingRows.mockResolvedValueOnce({
      rows: [
        {
          season_id: '30D',
          source: 'bitget_futures',
          source_trader_id: 'beb24d718eb23b54ac91',
          rank: 5,
          roi: 12.34,
        },
      ],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_period_not_published',
    })

    const fs = await getPublicFirstScreen(
      rpcClient({ ...rpcPayload, exchangeTraderId: 'different-account' }),
      'bitget_futures',
      'beb24d718eb23b54ac91'
    )

    expect(fs?.entries[0]).toMatchObject({
      rank: null,
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'first_screen_identity_mismatch',
      headlineRoi: null,
      headlinePnl: null,
    })
  })

  it('reads the public cohort under the public alias while the RPC keeps the slug', async () => {
    mockFetchPublicProfileRankingRows.mockResolvedValue({
      rows: [
        {
          source: 'bitget',
          source_trader_id: 'beb24d718eb23b54ac91',
          season_id: '30D',
          rank: 4,
          roi: 12.34,
        },
      ],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_period_not_published',
    })

    const fs = await getPublicFirstScreen(
      rpcClient(rpcPayload),
      'bitget_futures',
      'beb24d718eb23b54ac91',
      'bitget'
    )

    expect(mockFetchPublicProfileRankingRows).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ source: 'bitget', sourceTraderId: 'beb24d718eb23b54ac91' })
    )
    expect(fs?.source).toBe('bitget_futures')
    expect(fs?.entries[0]).toMatchObject({ rank: 4, headlineRoi: 12.34 })
  })

  it('returns null on RPC null (unknown trader) and on error', async () => {
    expect(await getFirstScreen(rpcClient(null), 'bitget_futures', 'nope')).toBeNull()
    expect(await getFirstScreen(rpcClient(null, { message: 'x' }), 's', 't')).toBeNull()
  })
})

describe('serving core helpers', () => {
  it('tfToInt maps inception to 0', () => {
    expect(tfToInt('inception')).toBe(0)
    expect(tfToInt(7)).toBe(7)
  })

  it('isFresh respects the TTL window', () => {
    expect(isFresh(new Date(Date.now() - 30_000).toISOString(), 60)).toBe(true)
    expect(isFresh(new Date(Date.now() - 90_000).toISOString(), 60)).toBe(false)
    expect(isFresh(null, 60)).toBe(false)
    expect(isFresh('garbage', 60)).toBe(false)
  })
})

describe('getSourceCapabilities', () => {
  it('maps native/derived/absent timeframes, inception flag and surfaces', async () => {
    const supabase = rpcClient({
      bitget_bots: {
        exchangeName: 'Bitget',
        currency: 'USDT',
        isOnchain: false,
        copierDepth: 'full',
        timeframesNative: [0, 7, 30, 90],
        timeframesDerived: [],
        metrics: ['roi', 'pnl', 'mdd'],
        surfaces: { positions: true, copiers: true },
      },
      mexc_futures: {
        exchangeName: 'MEXC',
        currency: 'USDT',
        isOnchain: false,
        copierDepth: 'bogus-depth',
        timeframesNative: [7],
        timeframesDerived: [30, 90],
        metrics: [],
        surfaces: {},
      },
    })
    const caps = await getSourceCapabilities(supabase)
    expect(caps.bitget_bots.inceptionTf).toBe(true)
    expect(caps.bitget_bots.timeframes).toEqual({ '7': 'native', '30': 'native', '90': 'native' })
    expect(caps.bitget_bots.surfaces.positions).toBe(true)
    expect(caps.bitget_bots.surfaces.orders).toBe(false)
    expect(caps.mexc_futures.timeframes).toEqual({
      '7': 'native',
      '30': 'derived',
      '90': 'derived',
    })
    expect(caps.mexc_futures.derivedBoardNote).toBe(true)
    expect(caps.mexc_futures.copierDepth).toBe('none') // unknown depth collapses safely
  })

  it('returns {} on error', async () => {
    expect(await getSourceCapabilities(rpcClient(null, { message: 'x' }))).toEqual({})
  })
})
