import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RankingTable } from '../RankingTable'
import type { Trader } from '../RankingTableTypes'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

jest.mock('@/lib/hooks/useTableKeyboardNav', () => ({
  useTableKeyboardNav: () => ({ containerProps: {}, getRowProps: () => ({}) }),
}))

jest.mock('../useRankingTableStyles', () => ({ useRankingTableStyles: () => undefined }))

jest.mock('../TraderRow', () => ({
  TraderRow: ({ trader }: { trader: Trader }) => <div data-testid="row">{trader.id}</div>,
}))

jest.mock('../MobileRankRows', () => ({
  MobileRankHeader: jest.requireActual('../MobileRankRows').MobileRankHeader,
  TraderMobileRow: ({ trader }: { trader: Trader }) => <div data-testid="card">{trader.id}</div>,
}))

jest.mock('../../ui/AvatarPreload', () => ({ AvatarPreload: () => null }))

// next/dynamic → a Pagination stub that exposes the hasMore witness it received.
jest.mock('next/dynamic', () => () => {
  function PaginationStub(props: { hasMore?: boolean; currentPage?: number }) {
    // Other dynamic() components share this mock; only Pagination has currentPage.
    if (props.currentPage === undefined) return null
    return (
      <nav
        data-testid="pagination"
        data-has-more={String(props.hasMore === true)}
        data-page={props.currentPage}
      />
    )
  }
  return PaginationStub
})

function makeTraders(n: number): Trader[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t-${i + 1}`,
    handle: `T ${i + 1}`,
    roi: 10,
    followers: 0,
    arena_score: 80,
    rank: i + 1,
  }))
}

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

describe('RankingTable mobile card pagination', () => {
  const originalResizeObserver = global.ResizeObserver
  const originalFetch = global.fetch
  const originalIO = global.IntersectionObserver

  beforeEach(() => {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    global.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as jest.Mock
    setViewport(true)
  })

  afterEach(() => {
    cleanup()
    global.ResizeObserver = originalResizeObserver
    global.IntersectionObserver = originalIO
    global.fetch = originalFetch
  })

  it('renders server pagination in card view and hides endOfList while hasMore=true', () => {
    render(
      <RankingTable
        traders={makeTraders(50)}
        loading={false}
        loggedIn
        controlledPage={1}
        serverTotalCount={null}
        totalCountIsExact={false}
        hasMore
      />
    )
    expect(screen.getAllByTestId('card')).toHaveLength(50)
    const pagination = screen.getByTestId('pagination')
    expect(pagination).toHaveAttribute('data-has-more', 'true')
    expect(screen.queryByText('endOfList')).not.toBeInTheDocument()
  })

  it('lets mobile users change the server sort order from the compact header', () => {
    const onSortChange = jest.fn()
    render(
      <RankingTable
        traders={makeTraders(5)}
        loading={false}
        loggedIn
        controlledPage={1}
        controlledSortColumn="score"
        controlledSortDir="desc"
        onSortChange={onSortChange}
        hasMore={false}
      />
    )
    const select = screen.getByRole('combobox', { name: 'rankingMobileSortLabel' })
    expect(select).toHaveValue('score:desc')
    fireEvent.change(select, { target: { value: 'roi:desc' } })
    expect(onSortChange).toHaveBeenCalledWith('roi', 'desc')
    fireEvent.change(select, { target: { value: 'mdd:asc' } })
    expect(onSortChange).toHaveBeenLastCalledWith('mdd', 'asc')
  })

  it('shows endOfList only when the server proves there is no next page', () => {
    render(
      <RankingTable
        traders={makeTraders(30)}
        loading={false}
        loggedIn
        controlledPage={3}
        serverTotalCount={null}
        totalCountIsExact={false}
        hasMore={false}
      />
    )
    expect(screen.getByTestId('pagination')).toHaveAttribute('data-has-more', 'false')
    expect(screen.getByText('endOfList')).toBeInTheDocument()
  })
})
