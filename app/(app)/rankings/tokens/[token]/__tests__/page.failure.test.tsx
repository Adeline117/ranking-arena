import type { ReactElement } from 'react'

const mockGetTokenTraderRankingSnapshot = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockNotFound = jest.fn()
const mockRedirect = jest.fn()
const redirectError = new Error('NEXT_REDIRECT')

jest.mock('next/navigation', () => ({
  notFound: (...args: unknown[]) => mockNotFound(...args),
  redirect: (...args: unknown[]) => {
    mockRedirect(...args)
    throw redirectError
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/rankings/token-ranking-snapshot', () => {
  const actual = jest.requireActual('@/lib/rankings/token-ranking-snapshot')
  return {
    ...actual,
    getTokenTraderRankingSnapshot: (...args: unknown[]) =>
      mockGetTokenTraderRankingSnapshot(...args),
  }
})

jest.mock('../TokenRankingClient', () => ({
  __esModule: true,
  default: () => null,
}))

import TokenDetailPage, {
  generateMetadata,
  loadTokenTradersSSR,
  parseTokenPageQuery,
} from '../page'
import { TokenRankingReadError } from '@/lib/rankings/token-ranking-snapshot'

const PUBLISHED_AT = '2026-07-29T20:00:00.123Z'
const supabase = { rpc: jest.fn() }

function makeSnapshot({
  generation = '17',
  period = '90D',
  page = 0,
  total = 0,
  traders = [],
}: {
  generation?: string
  period?: '7D' | '30D' | '90D'
  page?: number
  total?: number
  traders?: unknown[]
} = {}) {
  return {
    contract: 'token-ranking-page@1',
    generation,
    profilePublicationId: null,
    publishedAt: PUBLISHED_AT,
    publishedAtEpochMs: Date.parse(PUBLISHED_AT),
    windowThroughDate: '2026-07-29',
    sourceAsOf: null,
    sourceThroughDate: '2026-07-29',
    dailyRowCount: 123,
    popularRowCount: 25,
    token: 'BTC',
    period,
    lookbackDays: period === '7D' ? 7 : period === '30D' ? 30 : 90,
    limit: 50,
    offset: page * 50,
    total,
    traders,
  }
}

type TokenDetailProps = {
  token: string
  initialPeriod: string
  initialPage: number
  requestedGeneration: string | null
  initialSnapshot: unknown
  initialStatus: 'success' | 'unpublished' | 'error'
}

describe('token ranking detail SSR publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSupabaseAdmin.mockReturnValue(supabase)
  })

  it('strictly canonicalizes period, page, generation, duplicate values, and unknown keys', () => {
    expect(parseTokenPageQuery({})).toEqual({
      period: '90D',
      page: 0,
      generation: undefined,
      canonical: true,
    })
    expect(parseTokenPageQuery({ period: '7D', page: '2', generation: '17' })).toEqual({
      period: '7D',
      page: 2,
      generation: '17',
      canonical: true,
    })

    for (const query of [
      { period: '90D' },
      { period: '7d' },
      { period: '1D' },
      { page: '0' },
      { page: '02' },
      { page: '40001' },
      { generation: '017' },
      { generation: '9007199254740001' },
      { period: ['7D', '30D'] },
      { unexpected: '1' },
    ]) {
      expect(parseTokenPageQuery(query).canonical).toBe(false)
    }
  })

  it('keeps detail verification pages out of search indexes and removes ranking claims', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ token: 'btc' }) })

    expect(metadata.robots).toEqual({ index: false, follow: true })
    expect(JSON.stringify(metadata)).not.toMatch(/\bbest\b|\btop\b|latest available/i)
  })

  it('redirects lowercase paths and noncanonical queries before reading a snapshot', async () => {
    await expect(
      TokenDetailPage({
        params: Promise.resolve({ token: 'btc' }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toBe(redirectError)
    expect(mockRedirect).toHaveBeenLastCalledWith('/rankings/tokens/BTC')

    await expect(
      TokenDetailPage({
        params: Promise.resolve({ token: 'BTC' }),
        searchParams: Promise.resolve({ period: '90D', page: '02', ignored: 'yes' }),
      })
    ).rejects.toBe(redirectError)
    expect(mockRedirect).toHaveBeenLastCalledWith('/rankings/tokens/BTC')
    expect(mockGetTokenTraderRankingSnapshot).not.toHaveBeenCalled()
  })

  it('loads the requested generation and direct page with the exact database offset', async () => {
    const snapshot = makeSnapshot({ generation: '17', period: '7D', page: 2, total: 101 })
    mockGetTokenTraderRankingSnapshot.mockResolvedValue(snapshot)

    const element = (await TokenDetailPage({
      params: Promise.resolve({ token: 'BTC' }),
      searchParams: Promise.resolve({ period: '7D', page: '2', generation: '17' }),
    })) as ReactElement<TokenDetailProps>

    expect(mockGetTokenTraderRankingSnapshot).toHaveBeenCalledWith(
      supabase,
      {
        token: 'BTC',
        period: '7D',
        limit: 50,
        offset: 100,
        generation: '17',
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(element.props).toMatchObject({
      token: 'BTC',
      initialPeriod: '7D',
      initialPage: 2,
      requestedGeneration: '17',
      initialSnapshot: snapshot,
      initialStatus: 'success',
    })
  })

  it('forwards an explicit abort signal through the exported SSR loader', async () => {
    const snapshot = makeSnapshot()
    const controller = new AbortController()
    mockGetTokenTraderRankingSnapshot.mockResolvedValue(snapshot)

    await expect(loadTokenTradersSSR('BTC', '90D', 0, '17', controller.signal)).resolves.toBe(
      snapshot
    )
    expect(mockGetTokenTraderRankingSnapshot).toHaveBeenCalledWith(
      supabase,
      { token: 'BTC', period: '90D', limit: 50, offset: 0, generation: '17' },
      { signal: controller.signal }
    )
  })

  it('keeps a legitimate empty published snapshot distinct from failure', async () => {
    const snapshot = makeSnapshot()
    mockGetTokenTraderRankingSnapshot.mockResolvedValue(snapshot)

    const element = (await TokenDetailPage({
      params: Promise.resolve({ token: 'BTC' }),
      searchParams: Promise.resolve({ generation: '17' }),
    })) as ReactElement<TokenDetailProps>

    expect(element.props).toMatchObject({
      initialPage: 0,
      requestedGeneration: '17',
      initialSnapshot: snapshot,
      initialStatus: 'success',
    })
  })

  it('preserves intentional unpublished separately from a retryable failure', async () => {
    mockGetTokenTraderRankingSnapshot.mockRejectedValue(
      new TokenRankingReadError('not_published', 'authority snapshot required')
    )

    const element = (await TokenDetailPage({
      params: Promise.resolve({ token: 'BTC' }),
      searchParams: Promise.resolve({ generation: '17' }),
    })) as ReactElement<TokenDetailProps>

    expect(element.props).toMatchObject({
      initialSnapshot: null,
      initialStatus: 'unpublished',
    })
  })

  it('aborts a timed-out SSR read and seeds an explicit failure instead of fake empty data', async () => {
    jest.useFakeTimers()
    try {
      let receivedSignal: AbortSignal | undefined
      mockGetTokenTraderRankingSnapshot.mockImplementation(
        (_client: unknown, _input: unknown, options: { signal?: AbortSignal } | undefined) => {
          receivedSignal = options?.signal
          return new Promise(() => undefined)
        }
      )
      const page = TokenDetailPage({
        params: Promise.resolve({ token: 'BTC' }),
        searchParams: Promise.resolve({ generation: '17' }),
      })

      await jest.advanceTimersByTimeAsync(4_000)

      const element = (await page) as ReactElement<TokenDetailProps>
      expect(element.props.initialSnapshot).toBeNull()
      expect(element.props.initialStatus).toBe('error')
      expect(element.props.requestedGeneration).toBe('17')
      expect(receivedSignal?.aborted).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('redirects an out-of-range direct page to the actual snapshot generation last page', async () => {
    mockGetTokenTraderRankingSnapshot.mockResolvedValue(
      makeSnapshot({ generation: '18', period: '30D', page: 3, total: 51 })
    )

    await expect(
      TokenDetailPage({
        params: Promise.resolve({ token: 'BTC' }),
        searchParams: Promise.resolve({ period: '30D', page: '3' }),
      })
    ).rejects.toBe(redirectError)

    expect(mockRedirect).toHaveBeenLastCalledWith(
      '/rankings/tokens/BTC?period=30D&page=1&generation=18'
    )
  })
})
