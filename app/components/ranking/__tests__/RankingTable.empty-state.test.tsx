import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RankingTable } from '../RankingTable'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/lib/hooks/useTableKeyboardNav', () => ({
  useTableKeyboardNav: () => ({ containerProps: {}, getRowProps: () => ({}) }),
}))
jest.mock('../useRankingTableStyles', () => ({ useRankingTableStyles: () => undefined }))
jest.mock('../../ui/AvatarPreload', () => ({ AvatarPreload: () => null }))
jest.mock('next/dynamic', () => () => () => null)

describe('RankingTable empty / error states', () => {
  const originalResizeObserver = global.ResizeObserver
  beforeEach(() => {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    window.matchMedia = jest.fn(
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        }) as unknown as MediaQueryList
    )
  })
  afterEach(() => {
    cleanup()
    global.ResizeObserver = originalResizeObserver
  })

  it('unfiltered + stale shows the refreshing copy (not a generic "no data")', () => {
    render(<RankingTable traders={[]} loading={false} loggedIn isStale onRetry={jest.fn()} />)
    expect(screen.getByText('rankingsRefreshingTitle')).toBeInTheDocument()
    expect(screen.queryByText('noTraderData')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'retry' })).toHaveLength(1)
  })

  it('unfiltered + fresh shows the empty-period copy', () => {
    render(<RankingTable traders={[]} loading={false} loggedIn />)
    expect(screen.getByText('rankingsEmptyPeriodTitle')).toBeInTheDocument()
  })

  it('filters-only empty state resets filters instead of a no-op "clear search"', () => {
    const onResetFilters = jest.fn()
    render(
      <RankingTable
        traders={[]}
        loading={false}
        loggedIn
        hasActiveFilters
        onResetFilters={onResetFilters}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'resetFilters' }))
    expect(onResetFilters).toHaveBeenCalledTimes(1)
  })

  it('error state shows a heading, the message, and one retry', () => {
    render(<RankingTable traders={[]} loading={false} loggedIn error="boom" onRetry={jest.fn()} />)
    expect(screen.getByText('failedToLoadRankings')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'retry' })).toHaveLength(1)
  })
})
