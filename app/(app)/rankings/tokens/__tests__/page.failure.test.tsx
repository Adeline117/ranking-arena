import type { ReactElement } from 'react'

const mockGetPopularTokenRankingSnapshot = jest.fn()
const mockGetSupabaseAdmin = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/rankings/token-ranking-snapshot', () => {
  const actual = jest.requireActual('@/lib/rankings/token-ranking-snapshot')
  return {
    ...actual,
    getPopularTokenRankingSnapshot: (...args: unknown[]) =>
      mockGetPopularTokenRankingSnapshot(...args),
  }
})

jest.mock('../TokensIndexClient', () => ({
  __esModule: true,
  default: () => null,
}))

import TokensPage, { loadPopularTokensSSR, metadata } from '../page'
import { TokenRankingReadError } from '@/lib/rankings/token-ranking-snapshot'

const supabase = { rpc: jest.fn() }
const snapshot = {
  contract: 'popular-token-page@1',
  generation: '7',
  publishedAt: '2026-07-29T20:00:00.123Z',
  publishedAtEpochMs: Date.parse('2026-07-29T20:00:00.123Z'),
  windowThroughDate: '2026-07-29',
  sourceAsOf: null,
  sourceThroughDate: '2026-07-29',
  dailyRowCount: 123,
  popularRowCount: 0,
  lookbackDays: 90,
  limit: 50,
  total: 0,
  tokens: [],
}

type TokensPageProps = {
  initialSnapshot: unknown
  initialStatus: 'success' | 'unpublished' | 'error'
}

describe('token rankings index SSR publication state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSupabaseAdmin.mockReturnValue(supabase)
  })

  it('keeps the verification route out of search indexes without best-trader claims', () => {
    expect(metadata.robots).toEqual({ index: false, follow: true })
    expect(JSON.stringify(metadata)).not.toMatch(/\bbest\b|\bdiscover\b/i)
  })

  it('uses the generation-coordinated v2 snapshot service and passes its full publication', async () => {
    mockGetPopularTokenRankingSnapshot.mockResolvedValue(snapshot)

    await expect(loadPopularTokensSSR()).resolves.toBe(snapshot)
    expect(mockGetPopularTokenRankingSnapshot).toHaveBeenCalledWith(
      supabase,
      { limit: 50 },
      undefined
    )

    const element = (await TokensPage()) as ReactElement<TokensPageProps>
    expect(element.props).toMatchObject({
      initialSnapshot: snapshot,
      initialStatus: 'success',
    })
  })

  it('marks an upstream failure as failed without fabricating an empty generation', async () => {
    mockGetPopularTokenRankingSnapshot.mockRejectedValue(new Error('database unavailable'))

    await expect(loadPopularTokensSSR()).rejects.toThrow('database unavailable')

    const element = (await TokensPage()) as ReactElement<TokensPageProps>
    expect(element.props).toMatchObject({
      initialSnapshot: null,
      initialStatus: 'error',
    })
  })

  it('preserves the intentional unpublished state without issuing a fake empty snapshot', async () => {
    mockGetPopularTokenRankingSnapshot.mockRejectedValue(
      new TokenRankingReadError('not_published', 'authority snapshot required')
    )

    const element = (await TokensPage()) as ReactElement<TokensPageProps>
    expect(element.props).toMatchObject({
      initialSnapshot: null,
      initialStatus: 'unpublished',
    })
  })

  it('keeps a legitimate empty published generation distinct from failure', async () => {
    mockGetPopularTokenRankingSnapshot.mockResolvedValue(snapshot)

    const element = (await TokensPage()) as ReactElement<TokensPageProps>
    expect(element.props).toMatchObject({
      initialSnapshot: snapshot,
      initialStatus: 'success',
    })
  })

  it('aborts and marks an SSR timeout as failure instead of an empty success', async () => {
    jest.useFakeTimers()
    try {
      let receivedSignal: AbortSignal | undefined
      mockGetPopularTokenRankingSnapshot.mockImplementation(
        (_client: unknown, _input: unknown, options: { signal?: AbortSignal } | undefined) => {
          receivedSignal = options?.signal
          return new Promise(() => undefined)
        }
      )
      const page = TokensPage()

      await jest.advanceTimersByTimeAsync(4_000)

      const element = (await page) as ReactElement<TokensPageProps>
      expect(element.props).toMatchObject({
        initialSnapshot: null,
        initialStatus: 'error',
      })
      expect(receivedSignal?.aborted).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})
