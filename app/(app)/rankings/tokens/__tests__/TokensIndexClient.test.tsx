import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import TokensIndexClient, {
  parsePopularTokenIndexSnapshot,
  type PopularTokenIndexSnapshot,
} from '../TokensIndexClient'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => key,
  }),
}))

const PUBLISHED_AT = '2026-07-29T20:00:00.123Z'

function makeSnapshot(
  generation = '7',
  tokens: PopularTokenIndexSnapshot['tokens'] = [
    { token: 'BTC', trade_count: 10, trader_count: 3, total_pnl: 100 },
  ]
): PopularTokenIndexSnapshot {
  return {
    contract: 'popular-token-page@1',
    generation,
    publishedAt: PUBLISHED_AT,
    publishedAtEpochMs: Date.parse(PUBLISHED_AT),
    windowThroughDate: '2026-07-29',
    sourceAsOf: null,
    sourceThroughDate: '2026-07-29',
    dailyRowCount: 123,
    popularRowCount: tokens.length,
    lookbackDays: 90,
    limit: 50,
    total: tokens.length,
    tokens,
  }
}

function fetchResponse(body: unknown, ok = true, status = ok ? 200 : 503) {
  return {
    ok,
    status,
    json: async () => body,
  }
}

const originalFetch = global.fetch

describe('TokensIndexClient publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('keeps controlled search and sort inputs inert in SSR markup', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToStaticMarkup(
      <TokensIndexClient initialSnapshot={makeSnapshot()} />
    )

    expect(container.querySelector('.tk-search-input')).toBeDisabled()
    for (const button of container.querySelectorAll('.tk-sort-btn')) {
      expect(button).toBeDisabled()
    }
  })

  it('hydrates an SSR snapshot with generation, publication, and total intact', async () => {
    const { container } = render(<TokensIndexClient initialSnapshot={makeSnapshot()} />)

    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeEnabled()
    }

    const grid = container.querySelector('[data-generation="7"]')
    expect(grid).toHaveAttribute('data-published-at', PUBLISHED_AT)
    expect(grid).toHaveAttribute('data-total', '1')
    expect(screen.getByRole('link', { name: /BTC/ })).toHaveAttribute('data-trader-count', '3')
    expect(screen.getByText('provenanceSource: Arena · provenanceAsOf unknown')).toBeInTheDocument()
    expect(screen.queryByText(PUBLISHED_AT)).not.toBeInTheDocument()
  })

  it('keeps missing featured-token metrics unknown instead of fabricating zeroes', async () => {
    global.fetch = jest.fn()
    const { container } = render(
      <TokensIndexClient initialSnapshot={makeSnapshot('8', [])} initialStatus="success" />
    )

    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())

    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    const btc = container.querySelector('[data-token="BTC"]')
    expect(btc).toHaveAttribute('data-metrics-known', 'false')
    expect(btc).not.toHaveAttribute('data-trader-count')
    expect(btc).not.toHaveAttribute('data-trade-count')
    expect(btc).not.toHaveAttribute('data-total-pnl')
    expect(btc).toHaveAccessibleName('BTC — unknown')
  })

  it('strictly parses a complete API snapshot and rejects malformed contracts', () => {
    expect(parsePopularTokenIndexSnapshot(makeSnapshot())).toEqual(makeSnapshot())

    const extraKey = { ...makeSnapshot(), unexpected: true }
    const wrongGeneration = { ...makeSnapshot(), generation: '07' }
    const wrongEpoch = { ...makeSnapshot(), publishedAtEpochMs: Date.parse(PUBLISHED_AT) + 1 }
    const futureSourceEvidence = {
      ...makeSnapshot(),
      sourceAsOf: '2026-07-29T20:06:00.123Z',
    }
    const impossibleDate = {
      ...makeSnapshot(),
      publishedAt: '2026-02-30T20:00:00.123Z',
      publishedAtEpochMs: Date.parse('2026-02-30T20:00:00.123Z'),
    }
    const wrongCardinality = { ...makeSnapshot(), total: 2 }
    const stringCount = {
      ...makeSnapshot(),
      tokens: [{ token: 'BTC', trade_count: '10', trader_count: 3, total_pnl: 100 }],
    }
    const outOfOrder = makeSnapshot('7', [
      { token: 'BTC', trade_count: 10, trader_count: 3, total_pnl: 100 },
      { token: 'ETH', trade_count: 11, trader_count: 2, total_pnl: 50 },
    ])

    for (const invalid of [
      extraKey,
      wrongGeneration,
      wrongEpoch,
      futureSourceEvidence,
      impossibleDate,
      wrongCardinality,
      stringCount,
      outOfOrder,
    ]) {
      expect(() => parsePopularTokenIndexSnapshot(invalid)).toThrow(/popular-tokens/)
    }
  })

  it('atomically installs one API generation after failed SSR without retaining stale rows', async () => {
    const generationEight = makeSnapshot('8', [
      { token: 'ETH', trade_count: 12, trader_count: 4, total_pnl: 250 },
    ])
    global.fetch = jest.fn().mockResolvedValue(fetchResponse(generationEight))

    const { container } = render(
      <TokensIndexClient initialSnapshot={makeSnapshot('7')} initialStatus="error" />
    )

    await waitFor(() => expect(container.querySelector('[data-generation="8"]')).not.toBeNull())

    expect(container.querySelector('[data-generation="7"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-token="ETH"]')).toHaveAttribute('data-trader-count', '4')
    expect(container.querySelector('[data-token="BTC"]')).toHaveAttribute(
      'data-metrics-known',
      'false'
    )
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/rankings/by-token?action=popular-tokens',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) })
    )
  })

  it('does not install any field from a malformed next generation', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fetchResponse({
        ...makeSnapshot('8'),
        tokens: [{ token: 'BTC', trade_count: 10, trader_count: 3, total_pnl: 100 }],
        total: 2,
      })
    )

    const { container } = render(<TokensIndexClient initialSnapshot={null} initialStatus="error" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(container.querySelector('[data-generation]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-token]')).not.toBeInTheDocument()
  })

  it('keeps the previous complete generation on refresh errors instead of mixing partial data', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(fetchResponse({ error: 'Unavailable' }, false, 503))
      .mockResolvedValueOnce(
        fetchResponse(
          makeSnapshot('9', [{ token: 'SOL', trade_count: 12, trader_count: 4, total_pnl: 250 }])
        )
      )
    const { container } = render(<TokensIndexClient initialSnapshot={null} initialStatus="error" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(container.querySelector('[data-generation]')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))

    await waitFor(() => expect(container.querySelector('[data-generation="9"]')).not.toBeNull())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(container.querySelector('[data-token="SOL"]')).toHaveAttribute('data-trader-count', '4')
  })

  it('preserves accessible search and pressed-state sorting', async () => {
    const { container } = render(
      <TokensIndexClient
        initialSnapshot={makeSnapshot('10', [
          { token: 'BTC', trade_count: 10, trader_count: 3, total_pnl: 100 },
          { token: 'ETH', trade_count: 20, trader_count: 2, total_pnl: 50 },
        ])}
      />
    )

    const search = await screen.findByRole('textbox', { name: 'tokenRankingsSearchPlaceholder' })
    fireEvent.change(search, { target: { value: 'eth' } })

    expect(container.querySelector('[data-token="ETH"]')).toBeInTheDocument()
    expect(container.querySelector('[data-token="BTC"]')).not.toBeInTheDocument()

    const trades = screen.getByRole('button', { name: 'tokenRankingsSortTrades' })
    fireEvent.click(trades)
    expect(trades).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('group', { name: 'tokenRankingsSortLabel' })).toBeInTheDocument()
  })
})
