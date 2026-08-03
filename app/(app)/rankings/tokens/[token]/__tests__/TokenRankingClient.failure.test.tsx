import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TokenRankingClient, {
  normalizeTokenRankingPageResponse,
  type Period,
  type TokenRankingSnapshotSeed,
  type TokenTrader,
} from '../TokenRankingClient'

const mockSearchParams = new URLSearchParams()

function syncSearchParams(url: string): void {
  const parsed = new URL(url, 'https://arena.example')
  for (const key of Array.from(mockSearchParams.keys())) mockSearchParams.delete(key)
  parsed.searchParams.forEach((value, key) => mockSearchParams.append(key, value))
}

const mockReplace = jest.fn((url: string) => syncSearchParams(url))
const mockPush = jest.fn((url: string) => syncSearchParams(url))
const mockRouter = { push: mockPush, replace: mockReplace }

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/rankings/tokens/BTC',
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/app/components/common/ProvenanceFooter', () => ({
  __esModule: true,
  default: ({ provenance }: { provenance: { asOf: string } }) => (
    <div data-testid="provenance-footer">{provenance.asOf}</div>
  ),
}))

const PUBLISHED_AT = '2026-07-29T20:00:00.123Z'
const originalFetch = global.fetch

function makeTrader(rank: number, overrides: Partial<TokenTrader> = {}): TokenTrader {
  return {
    source: 'binance_futures',
    source_trader_id: `trader-${rank}`,
    handle: `Trader ${rank}`,
    avatar_url: null,
    arena_score: 80,
    roi: 12,
    total_pnl: 500,
    token_rank: rank,
    token_pnl: 200 - rank,
    token_trade_count: 8,
    token_win_rate: 62,
    token_avg_pnl_pct: 3,
    ...overrides,
  }
}

function makeSnapshot({
  generation = '7',
  profilePublicationId = null,
  period = '90D',
  page = 0,
  total = 0,
  traders,
  sourceAsOf = null,
}: {
  generation?: string
  profilePublicationId?: string | null
  period?: Period
  page?: number
  total?: number
  traders?: TokenTrader[]
  sourceAsOf?: string | null
} = {}): TokenRankingSnapshotSeed {
  const offset = page * 50
  const expectedLength = Math.min(50, Math.max(total - offset, 0))
  return {
    contract: 'token-ranking-page@1',
    generation,
    profilePublicationId,
    publishedAt: PUBLISHED_AT,
    publishedAtEpochMs: Date.parse(PUBLISHED_AT),
    windowThroughDate: '2026-07-29',
    sourceAsOf,
    sourceThroughDate: '2026-07-29',
    dailyRowCount: 123,
    popularRowCount: 25,
    token: 'BTC',
    period,
    lookbackDays: period === '7D' ? 7 : period === '30D' ? 30 : 90,
    limit: 50,
    offset,
    total,
    traders:
      traders ??
      Array.from({ length: expectedLength }, (_, index) => makeTrader(offset + index + 1)),
  }
}

function fetchResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function setSearchParams(values: Record<string, string> = {}): void {
  for (const key of Array.from(mockSearchParams.keys())) mockSearchParams.delete(key)
  for (const [key, value] of Object.entries(values)) mockSearchParams.set(key, value)
}

describe('TokenRankingClient generation-bound failure handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setSearchParams()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('does not fetch or show an error for a legitimate empty SSR publication', async () => {
    setSearchParams({ generation: '7' })
    global.fetch = jest.fn()

    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialPage={0}
        requestedGeneration="7"
        initialSnapshot={makeSnapshot()}
      />
    )

    await waitFor(() => expect(screen.getAllByText(/tokenRankingNoData/).length).toBeGreaterThan(0))
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('always sends an explicit generation, exact offset, and no-store on a failed SSR seed', async () => {
    setSearchParams({ period: '30D', page: '2', generation: '7' })
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fetchResponse(makeSnapshot({ generation: '7', period: '30D', page: 2, total: 101 }))
      )

    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="30D"
        initialPage={2}
        requestedGeneration="7"
        initialSnapshot={null}
      />
    )

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    const request = new URL(url, 'https://arena.example')
    expect(Object.fromEntries(request.searchParams)).toMatchObject({
      token: 'BTC',
      period: '30D',
      limit: '50',
      offset: '100',
      generation: '7',
    })
    expect(init).toMatchObject({ cache: 'no-store', signal: expect.any(AbortSignal) })
  })

  it('uses history-push URLs for page and period interactions without dropping generation', () => {
    setSearchParams({ generation: '7' })
    global.fetch = jest.fn()
    const { unmount } = render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialPage={0}
        requestedGeneration="7"
        initialSnapshot={makeSnapshot({ total: 51 })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'tokenRankingNext' }))
    expect(mockPush).toHaveBeenLastCalledWith('/rankings/tokens/BTC?page=1&generation=7', {
      scroll: false,
    })
    unmount()

    setSearchParams({ generation: '7' })
    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialPage={0}
        requestedGeneration="7"
        initialSnapshot={makeSnapshot()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'days7' }))
    expect(mockPush).toHaveBeenLastCalledWith('/rankings/tokens/BTC?period=7D&generation=7', {
      scroll: false,
    })
  })

  it('strictly rejects shape drift, cardinality drift, non-authoritative ranks, and duplicate identities', () => {
    const valid = makeSnapshot({ total: 2 })
    expect(
      normalizeTokenRankingPageResponse(valid, {
        token: 'BTC',
        period: '90D',
        page: 0,
        generation: '7',
      })
    ).toMatchObject({ generation: '7', total: 2 })

    const wrongContract = { ...valid, contract: 'token-ranking-page@0' }
    const extraKey = { ...valid, unexpected: true }
    const wrongCardinality = { ...valid, traders: valid.traders.slice(0, 1) }
    const wrongRank = {
      ...valid,
      traders: [valid.traders[0], { ...valid.traders[1], token_rank: 3 }],
    }
    const duplicateIdentity = {
      ...valid,
      traders: [
        valid.traders[0],
        {
          ...valid.traders[1],
          source: valid.traders[0].source,
          source_trader_id: valid.traders[0].source_trader_id,
        },
      ],
    }

    for (const invalid of [
      wrongContract,
      extraKey,
      wrongCardinality,
      wrongRank,
      duplicateIdentity,
    ]) {
      expect(() =>
        normalizeTokenRankingPageResponse(invalid, {
          token: 'BTC',
          period: '90D',
          page: 0,
          generation: '7',
        })
      ).toThrow(/Token ranking response/)
    }
  })

  it('shows unknown source freshness and never substitutes publication time', () => {
    setSearchParams({ generation: '7' })
    global.fetch = jest.fn()
    const { container } = render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialPage={0}
        requestedGeneration="7"
        initialSnapshot={makeSnapshot({ sourceAsOf: null })}
      />
    )

    expect(screen.queryByTestId('provenance-footer')).not.toBeInTheDocument()
    expect(container).toHaveTextContent('provenanceAsOf unknown')
    expect(container).not.toHaveTextContent(PUBLISHED_AT)
  })

  it('rebases the first valid 409 to page zero of the new generation and retries once', async () => {
    setSearchParams({ page: '2', generation: '7' })
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        fetchResponse(
          {
            code: 'TOKEN_RANKING_GENERATION_CHANGED',
            current_generation: '8',
          },
          409
        )
      )
      .mockResolvedValueOnce(fetchResponse(makeSnapshot({ generation: '8' })))

    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialPage={2}
        requestedGeneration="7"
        initialSnapshot={null}
      />
    )

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    expect(mockReplace).toHaveBeenCalledWith('/rankings/tokens/BTC?generation=8', {
      scroll: false,
    })
    expect(String((global.fetch as jest.Mock).mock.calls[1][0])).toContain('generation=8')
    expect(String((global.fetch as jest.Mock).mock.calls[1][0])).toContain('offset=0')
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('stops with an error when the rebased generation conflicts a second time', async () => {
    setSearchParams({ generation: '7' })
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        fetchResponse(
          {
            code: 'TOKEN_RANKING_GENERATION_CHANGED',
            current_generation: '8',
          },
          409
        )
      )
      .mockResolvedValueOnce(
        fetchResponse(
          {
            code: 'TOKEN_RANKING_GENERATION_CHANGED',
            current_generation: '9',
          },
          409
        )
      )

    render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialPage={0}
        requestedGeneration="7"
        initialSnapshot={null}
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(mockReplace).toHaveBeenCalledTimes(1)
  })

  it('aborts a stale page request before installing a newer period response', async () => {
    setSearchParams({ generation: '7' })
    let resolveOld: ((value: ReturnType<typeof fetchResponse>) => void) | undefined
    let resolveCurrent: ((value: ReturnType<typeof fetchResponse>) => void) | undefined
    global.fetch = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof fetchResponse>>((resolve) => {
            resolveOld = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof fetchResponse>>((resolve) => {
            resolveCurrent = resolve
          })
      )

    const initial = makeSnapshot({ total: 51 })
    const view = render(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialPage={0}
        requestedGeneration="7"
        initialSnapshot={initial}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'tokenRankingNext' }))
    view.rerender(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialPage={0}
        requestedGeneration="7"
        initialSnapshot={initial}
      />
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    const oldSignal = (global.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal

    // Simulate a back/forward URL transition while the page request is in flight.
    // The controls are intentionally disabled during loading, but the URL remains
    // authoritative and must still cancel the stale request.
    setSearchParams({ period: '7D', generation: '7' })
    view.rerender(
      <TokenRankingClient
        token="BTC"
        initialPeriod="90D"
        initialPage={0}
        requestedGeneration="7"
        initialSnapshot={initial}
      />
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    expect(oldSignal.aborted).toBe(true)

    await act(async () => {
      resolveCurrent?.(
        fetchResponse(
          makeSnapshot({
            period: '7D',
            total: 1,
            traders: [makeTrader(1, { handle: 'Current period' })],
          })
        )
      )
    })
    await waitFor(() => expect(screen.getByText('Current period')).toBeInTheDocument())

    await act(async () => {
      resolveOld?.(
        fetchResponse(
          makeSnapshot({
            page: 1,
            total: 51,
            traders: [makeTrader(51, { handle: 'Stale page' })],
          })
        )
      )
    })
    expect(screen.queryByText('Stale page')).not.toBeInTheDocument()
    expect(screen.getByText('Current period')).toBeInTheDocument()
  })
})
