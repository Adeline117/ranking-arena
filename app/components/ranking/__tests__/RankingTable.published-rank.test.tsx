import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { RankingTable } from '../RankingTable'
import type { Trader } from '../RankingTableTypes'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

jest.mock('@/lib/hooks/useTableKeyboardNav', () => ({
  useTableKeyboardNav: () => ({
    containerProps: {},
    getRowProps: () => ({}),
  }),
}))

jest.mock('../useRankingTableStyles', () => ({
  useRankingTableStyles: () => undefined,
}))

jest.mock('../TraderRow', () => ({
  TraderRow: ({ trader, rank }: { trader: Trader; rank: number }) => (
    <div
      data-testid="published-rank-row"
      data-trader-id={trader.id}
      data-rank={rank}
      data-arena-score={trader.arena_score ?? 'unknown'}
    />
  ),
}))

jest.mock('../TraderCard', () => ({
  TraderCard: ({ trader, rank, series }: { trader: Trader; rank: number; series?: number[] }) => (
    <div
      data-testid="published-rank-card"
      data-trader-id={trader.id}
      data-rank={rank}
      data-arena-score={trader.arena_score ?? 'unknown'}
      data-rank-series={series ? JSON.stringify(series) : 'none'}
    />
  ),
}))

jest.mock('../../ui/AvatarPreload', () => ({
  AvatarPreload: () => null,
}))

jest.mock('next/dynamic', () => () => () => null)

const rankedTraders: Trader[] = [
  {
    id: 'published-37',
    handle: 'Published 37',
    roi: 37,
    followers: 0,
    arena_score: 99,
    rank: 37,
  },
  {
    id: 'unpublished',
    handle: 'Unpublished',
    roi: 999,
    followers: 0,
    arena_score: 999,
    rank: null,
  },
  {
    id: 'published-91',
    handle: 'Published 91',
    roi: 9,
    followers: 0,
    arena_score: 88,
    rank: 91,
  },
]

function setViewport(mobile: boolean) {
  window.matchMedia = jest.fn(
    (query: string) =>
      ({
        matches: query === '(max-width: 767px)' ? mobile : false,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(() => false),
      }) as MediaQueryList
  )
}

function renderRankingTable() {
  return render(
    <RankingTable
      traders={rankedTraders}
      loading={false}
      loggedIn
      controlledPage={5}
      serverTotalCount={1_000}
    />
  )
}

function rankAttributes(testId: string): Array<[string | null, string | null]> {
  return screen
    .getAllByTestId(testId)
    .map((node) => [node.getAttribute('data-trader-id'), node.getAttribute('data-rank')])
}

describe('RankingTable persisted rank authority', () => {
  const originalResizeObserver = global.ResizeObserver
  const originalFetch = global.fetch

  beforeEach(() => {
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as jest.Mock
  })

  afterEach(() => {
    cleanup()
    global.ResizeObserver = originalResizeObserver
    global.fetch = originalFetch
  })

  it('passes persisted ranks to desktop rows despite server pagination and excludes null rank', () => {
    setViewport(false)
    renderRankingTable()

    expect(rankAttributes('published-rank-row')).toEqual([
      ['published-37', '37'],
      ['published-91', '91'],
    ])
    expect(screen.queryByTestId('published-rank-card')).not.toBeInTheDocument()
    expect(screen.queryByText('Unpublished')).not.toBeInTheDocument()
  })

  it('passes the same persisted ranks to mobile cards and excludes null rank', () => {
    setViewport(true)
    renderRankingTable()

    expect(rankAttributes('published-rank-card')).toEqual([
      ['published-37', '37'],
      ['published-91', '91'],
    ])
    expect(screen.queryByTestId('published-rank-row')).not.toBeInTheDocument()
    expect(screen.queryByText('Unpublished')).not.toBeInTheDocument()
  })

  it.each([
    ['desktop row', false, 'published-rank-row'],
    ['mobile card', true, 'published-rank-card'],
  ])(
    'normalizes a non-finite score before the %s presentation receives it',
    (_surface, mobile, testId) => {
      setViewport(mobile)
      render(
        <RankingTable
          traders={[
            {
              ...rankedTraders[0],
              id: `non-finite-${testId}`,
              arena_score: Number.NaN,
              rank: 37,
            },
          ]}
          loading={false}
          loggedIn
          controlledPage={1}
          serverTotalCount={1}
        />
      )

      expect(screen.getByTestId(testId)).toHaveAttribute('data-arena-score', 'unknown')
    }
  )

  it('treats a corrupt local sort scalar as unknown instead of promoting it', () => {
    setViewport(false)
    render(
      <RankingTable
        traders={[
          {
            ...rankedTraders[0],
            id: 'corrupt-score',
            arena_score: Number.POSITIVE_INFINITY,
            rank: 37,
          },
          {
            ...rankedTraders[1],
            id: 'finite-score',
            arena_score: 88,
            rank: 91,
          },
        ]}
        loading={false}
        loggedIn
        controlledPage={1}
        controlledSortColumn="score"
        controlledSortDir="desc"
        serverTotalCount={2}
      />
    )

    expect(rankAttributes('published-rank-row')).toEqual([
      ['finite-score', '91'],
      ['corrupt-score', '37'],
    ])
  })

  it('rejects a legacy bare rank-history cache payload instead of replaying its sparkline', async () => {
    setViewport(true)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'binance_futures:published-37': [7, 3] }),
    }) as jest.Mock

    render(
      <RankingTable
        traders={[{ ...rankedTraders[0], source: 'binance_futures' }]}
        loading={false}
        loggedIn
        source="binance_futures"
        controlledPage={1}
        serverTotalCount={1}
      />
    )

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/rankings/rank-history',
        expect.objectContaining({ method: 'POST' })
      )
    })
    await waitFor(() => {
      expect(screen.getByTestId('published-rank-card')).toHaveAttribute('data-rank-series', 'none')
    })
  })
})
