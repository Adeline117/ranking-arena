import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import HomePage from '../HomePage'

jest.mock('../../layout/ThreeColumnLayout', () => ({
  __esModule: true,
  default: ({
    leftSidebar,
    rightSidebar,
    children,
  }: {
    leftSidebar?: ReactNode
    rightSidebar?: ReactNode
    children: ReactNode
  }) => (
    <div data-testid="three-column-layout">
      <aside data-testid="three-column-left">{leftSidebar}</aside>
      <main data-testid="three-column-center">{children}</main>
      <aside data-testid="three-column-right">{rightSidebar}</aside>
    </div>
  ),
}))

jest.mock('../HomePageClient', () => ({
  __esModule: true,
  default: ({ initialIsStale }: { initialIsStale?: boolean }) => (
    <div data-testid="ranking-center" data-initial-is-stale={String(initialIsStale)}>
      Rankings
    </div>
  ),
}))
jest.mock('../FoundingMemberBanner', () => ({
  __esModule: true,
  default: () => <div>Founding banner</div>,
}))
jest.mock('../ExchangePartners', () => ({
  __esModule: true,
  default: () => <div>Exchange partners</div>,
}))
jest.mock('../../sidebar/HotDiscussions', () => ({
  __esModule: true,
  default: () => <div data-testid="left-discovery">Hot discussions</div>,
}))
jest.mock('../../sidebar/WatchlistMarket', () => ({
  __esModule: true,
  default: () => <div data-testid="right-watchlist">Watchlist</div>,
}))
jest.mock('../../sidebar/TrendingHashtags', () => ({
  __esModule: true,
  default: () => <div data-testid="right-trends">Trending</div>,
}))
jest.mock('../../sidebar/NewsFlash', () => ({
  __esModule: true,
  default: () => <div data-testid="right-news">News</div>,
}))
jest.mock('../../layout/MobileBottomNav', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('../../layout/Footer', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('../../utils/ErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: { children: ReactNode }) => children,
}))
jest.mock('../../utils/DeferredMount', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => children,
}))
jest.mock('@/lib/features', () => ({ features: { social: true } }))

describe('HomePage protected information architecture', () => {
  it('keeps discovery left, rankings center, and market context right', async () => {
    render(<HomePage />)

    const layout = await screen.findByTestId('three-column-layout')
    const left = within(layout).getByTestId('three-column-left')
    const center = within(layout).getByTestId('three-column-center')
    const right = within(layout).getByTestId('three-column-right')

    expect(await within(left).findByTestId('left-discovery')).toBeInTheDocument()
    expect(within(center).getByTestId('ranking-center')).toBeInTheDocument()
    expect(await within(right).findByTestId('right-watchlist')).toBeInTheDocument()
    expect(await within(right).findByTestId('right-trends')).toBeInTheDocument()
    expect(await within(right).findByTestId('right-news')).toBeInTheDocument()
  })

  it('forwards the SSR source freshness flag into the interactive client', async () => {
    render(<HomePage initialIsStale />)

    expect(await screen.findByTestId('ranking-center')).toHaveAttribute(
      'data-initial-is-stale',
      'true'
    )
  })
})
