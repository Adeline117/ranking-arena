const mockResolveTrader = jest.fn()
const mockGetSupabaseAdmin = jest.fn()

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
  notFound: jest.fn(),
}))

jest.mock('@/lib/constants/urls', () => ({
  BASE_URL: 'https://arena.test',
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
}))

jest.mock('@/lib/data/verified-traders', () => ({
  getVerifiedTraderKeys: jest.fn(async () => new Set()),
  verifiedTraderKey: jest.fn((source: string, traderKey: string) => `${source}:${traderKey}`),
}))

jest.mock('@/lib/utils/og-verification-proof', () => ({
  createOgVerificationProof: jest.fn(async () => null),
}))

jest.mock('@/lib/constants/platform-labels', () => ({
  platformLabel: (platform: string) => platform,
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ warn: jest.fn() }),
}))

jest.mock('@/app/(app)/wrapped/[handle]/WrappedCardClient', () => ({
  __esModule: true,
  default: 'wrapped-card-client',
}))

import { generateMetadata } from '../page'

function shareProps(trader_key: string) {
  return {
    params: Promise.resolve({ trader_key }),
    searchParams: Promise.resolve({ platform: 'bybit', window: '7d' }),
  }
}

function publicRankedRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'bybit',
    source_trader_id: 'share-rank-authority-id',
    handle: 'Verified Trader',
    rank: 11,
    rank_change: -3,
    roi: 19.75,
    pnl: 1200,
    win_rate: 64,
    arena_score: 86,
    max_drawdown: 12,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    season_id: '7D',
    ...overrides,
  }
}

function publicRankedQuery(result: { data: unknown | null; error: { message: string } | null }) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue(result),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

describe('/share/rank/[trader_key] public rank authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses the verified public view and does not fabricate a total or percentile', async () => {
    const query = publicRankedQuery({ data: publicRankedRow(), error: null })
    const from = jest.fn((relation: string) => {
      if (relation === 'public_ranked_leaderboard') return query
      throw new Error(`unexpected relation: ${relation}`)
    })
    mockGetSupabaseAdmin.mockReturnValue({ from })
    mockResolveTrader.mockResolvedValueOnce({
      platform: 'bybit',
      traderKey: 'share-rank-authority-id',
      handle: 'Verified Trader',
      avatarUrl: null,
    })

    const metadata = await generateMetadata(shareProps('share-rank-authority'))

    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(query.select).toHaveBeenCalledWith(
      'rank,rank_change,roi,pnl,win_rate,arena_score,max_drawdown,source,source_trader_id,score_completeness,metrics_estimated,is_outlier,computed_at,season_id,idle_window'
    )
    expect(query.eq).toHaveBeenCalledWith('source', 'bybit')
    expect(query.eq).toHaveBeenCalledWith('source_trader_id', 'share-rank-authority-id')
    expect(query.eq).toHaveBeenCalledWith('season_id', '7D')
    expect(metadata.description).toContain('Ranked 11')
    expect(metadata.description).not.toContain('Top ')
    expect(JSON.stringify(metadata)).not.toContain('total=')
  })

  it('says an idle account had no trading and passes no rank, return or score to the image', async () => {
    const query = publicRankedQuery({
      data: publicRankedRow({ idle_window: true, arena_score: 0.01, roi: 0, pnl: 0 }),
      error: null,
    })
    const from = jest.fn((relation: string) => {
      if (relation === 'public_ranked_leaderboard') return query
      throw new Error(`unexpected relation: ${relation}`)
    })
    mockGetSupabaseAdmin.mockReturnValue({ from })
    mockResolveTrader.mockResolvedValueOnce({
      platform: 'bybit',
      traderKey: 'share-rank-authority-id',
      handle: 'Idle Trader',
      avatarUrl: null,
    })

    const metadata = await generateMetadata(shareProps('share-rank-authority'))
    const serialized = JSON.stringify(metadata)

    expect(metadata.description).toContain('had no trading in this ranking period')
    expect(metadata.description).not.toContain('Ranked')
    expect(serialized).toContain('idle=1')
    expect(serialized).not.toMatch(/[?&](rank|roi|score)=/)
  })

  it('suppresses rank and metrics when the public row is non-finite or incomplete', async () => {
    const query = publicRankedQuery({
      data: publicRankedRow({ max_drawdown: Number.NaN }),
      error: null,
    })
    const from = jest.fn((relation: string) => {
      if (relation === 'public_ranked_leaderboard') return query
      throw new Error(`unexpected relation: ${relation}`)
    })
    mockGetSupabaseAdmin.mockReturnValue({ from })
    mockResolveTrader.mockResolvedValueOnce({
      platform: 'bybit',
      traderKey: 'share-rank-authority-id',
      handle: 'Nonfinite Trader',
      avatarUrl: null,
    })

    const metadata = await generateMetadata(shareProps('share-nonfinite-rank-authority'))

    expect(metadata.description).not.toContain('Ranked')
    expect(JSON.stringify(metadata)).not.toMatch(/NaN|Infinity|total=/)
  })
})
