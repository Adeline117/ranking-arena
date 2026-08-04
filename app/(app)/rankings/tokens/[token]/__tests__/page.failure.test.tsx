import type { ReactElement } from 'react'

const mockGetTokenTraderRankings = jest.fn()
const mockReadSealedRankingAuthorityGeneration = jest.fn()
const mockNotFound = jest.fn()
const mockCurrentPublicationIdentity = 'current-publication'
let mockTokenPublicationIdentity = mockCurrentPublicationIdentity

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
  readSealedTokenTraderRankings: async (...args: unknown[]) => ({
    value: await mockGetTokenTraderRankings(...args),
    publicationIdentity: mockTokenPublicationIdentity,
  }),
}))

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingAuthorityGeneration: (...args: unknown[]) =>
    mockReadSealedRankingAuthorityGeneration(...args),
}))

jest.mock('../TokenRankingClient', () => ({
  __esModule: true,
  default: () => null,
}))

import TokenDetailPage, { dynamic, loadTokenTradersSSR, revalidate } from '../page'

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
    mockTokenPublicationIdentity = mockCurrentPublicationIdentity
    mockReadSealedRankingAuthorityGeneration.mockResolvedValue({
      publicationIdentity: mockCurrentPublicationIdentity,
    })
  })

  it('renders dynamically so HTML cannot outlive publication authority', () => {
    expect(dynamic).toBe('force-dynamic')
    expect(revalidate).toBe(0)
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

    await expect(loadTokenTradersSSR('BTC', '90D')).resolves.toEqual({ traders: [], total: 0 })

    const element = (await TokenDetailPage({
      params: Promise.resolve({ token: 'btc' }),
      searchParams: Promise.resolve({ period: '90D' }),
    })) as ReactElement<TokenDetailProps>
    expect(element.props).toMatchObject({
      initialTraders: [],
      initialTotal: 0,
      initialStatus: 'success',
    })
    expect(element.key).toBe('BTC')
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

  it('keys the SSR entry with current publication authority', async () => {
    mockGetTokenTraderRankings.mockResolvedValue({ traders: [], total: 0 })

    await loadTokenTradersSSR('BTC', '30D')

    expect(mockReadSealedRankingAuthorityGeneration).toHaveBeenCalledWith(
      { kind: 'admin-client' },
      '30D',
      expect.any(Function),
      { timeoutMs: 4_000 }
    )
    expect(mockGetTokenTraderRankings).toHaveBeenCalledWith(
      { kind: 'admin-client' },
      'BTC',
      '30D',
      50,
      0
    )
  })

  it('rejects a generation that changes before cache publication', async () => {
    mockTokenPublicationIdentity = 'superseded-publication'
    mockGetTokenTraderRankings.mockResolvedValue({ traders: [], total: 0 })

    await expect(loadTokenTradersSSR('BTC', '90D')).rejects.toThrow(
      'token ranking generation changed before SSR cache publication'
    )
  })
})
