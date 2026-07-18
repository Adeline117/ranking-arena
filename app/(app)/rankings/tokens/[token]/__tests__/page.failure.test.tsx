import type { ReactElement } from 'react'

const mockGetTokenTraderRankings = jest.fn()
const mockNotFound = jest.fn()

jest.mock('next/cache', () => ({
  unstable_cache: (loader: (...args: unknown[]) => unknown) => loader,
}))

jest.mock('next/navigation', () => ({
  notFound: (...args: unknown[]) => mockNotFound(...args),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ kind: 'admin-client' }),
}))

jest.mock('@/lib/rankings/token-traders', () => ({
  getTokenTraderRankings: (...args: unknown[]) => mockGetTokenTraderRankings(...args),
}))

jest.mock('../TokenRankingClient', () => ({
  __esModule: true,
  default: () => null,
}))

import TokenDetailPage, { loadTokenTradersSSR } from '../page'

type TokenDetailProps = {
  token: string
  initialPeriod: string
  initialTraders: unknown[]
  initialTotal: number
  initialStatus: 'success' | 'error'
}

describe('token ranking detail SSR state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('throws upstream failures out of the cached loader and marks the client seed failed', async () => {
    mockGetTokenTraderRankings.mockRejectedValue(new Error('database unavailable'))

    await expect(loadTokenTradersSSR('BTC', '90D')).rejects.toThrow('database unavailable')

    const element = (await TokenDetailPage({
      params: Promise.resolve({ token: 'btc' }),
      searchParams: Promise.resolve({ period: '7D' }),
    })) as ReactElement<TokenDetailProps>
    expect(element.props).toMatchObject({
      token: 'BTC',
      initialPeriod: '7D',
      initialTraders: [],
      initialTotal: 0,
      initialStatus: 'error',
    })
  })

  it('keeps a legitimate empty page distinct from failure', async () => {
    mockGetTokenTraderRankings.mockResolvedValue({ traders: [], total: 0 })

    const element = (await TokenDetailPage({
      params: Promise.resolve({ token: 'btc' }),
      searchParams: Promise.resolve({ period: '90D' }),
    })) as ReactElement<TokenDetailProps>
    expect(element.props).toMatchObject({
      initialTraders: [],
      initialTotal: 0,
      initialStatus: 'success',
    })
  })

  it('marks an SSR timeout as failure instead of an empty page', async () => {
    jest.useFakeTimers()
    try {
      mockGetTokenTraderRankings.mockReturnValue(new Promise(() => undefined))
      const page = TokenDetailPage({
        params: Promise.resolve({ token: 'btc' }),
        searchParams: Promise.resolve({ period: '90D' }),
      })

      await jest.advanceTimersByTimeAsync(4_000)

      const element = (await page) as ReactElement<TokenDetailProps>
      expect(element.props).toMatchObject({
        initialTraders: [],
        initialTotal: 0,
        initialStatus: 'error',
      })
    } finally {
      jest.useRealTimers()
    }
  })
})
