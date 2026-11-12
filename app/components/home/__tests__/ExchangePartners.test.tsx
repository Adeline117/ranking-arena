import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { VisibleLeaderboardSource } from '@/lib/data/visible-leaderboard-sources'

const mockRefetch = jest.fn()
const mockTrackEvent = jest.fn()
const mockUseQuery = jest.fn()
let mockSearch = 'range=30D'

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockSearch),
}))

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => mockUseQuery(options),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

jest.mock('../../Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        categoryFutures: 'Futures',
        categorySpot: 'Spot',
        categoryWeb3: 'On-chain',
        botsBot: 'Bot',
        traders: 'Traders',
        loadFailed: 'Failed to load, tap to retry',
        noData: 'No data',
      })[key] ?? key,
  }),
}))

jest.mock('../../ui/ExchangeLogo', () => ({
  __esModule: true,
  default: ({ exchange }: { exchange: string }) => <span data-logo={exchange} />,
}))

import ExchangePartners from '../ExchangePartners'

const source: VisibleLeaderboardSource = {
  registrySlug: 'bybit_copytrade',
  filterSource: 'bybit',
  exchangeSlug: 'bybit',
  exchangeName: 'Bybit',
  productType: 'futures',
  traderCount: 576,
  cacheUpdatedAt: '2026-07-16T07:00:00.000Z',
}

describe('ExchangePartners', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearch = 'range=30D'
    window.history.replaceState(null, '', '/?range=30D')
    mockUseQuery.mockReturnValue({
      data: [source],
      isLoading: false,
      error: null,
      refetch: mockRefetch,
    })
  })

  afterEach(cleanup)

  it('renders one accessible link plus an inert tab duplicate for seamless animation', () => {
    const { container } = render(<ExchangePartners />)

    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(container.querySelectorAll('a')).toHaveLength(2)
    expect(container.querySelector('a[aria-hidden="true"]')).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('link')).toHaveAttribute('href', '/?range=30D&exchange=bybit')
    expect(screen.getByRole('link')).toHaveAccessibleName('Bybit · Futures · 576 Traders')
  })

  it('defers the shareable URL update until the matching cohort succeeds, then dispatches, tracks, and scrolls', () => {
    const section = document.createElement('div')
    section.className = 'home-ranking-section'
    section.scrollIntoView = jest.fn()
    document.body.appendChild(section)
    const listener = jest.fn()
    window.addEventListener('arena:filter-exchange', listener)

    render(<ExchangePartners />)
    fireEvent.click(screen.getByRole('link'))

    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('?range=30D')
    expect(mockTrackEvent).toHaveBeenCalledWith('ranking_filter', {
      kind: 'source_marquee',
      value: 'bybit',
      registry_slug: 'bybit_copytrade',
      time_range: '30D',
    })
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { exchange: 'bybit', timeRange: '30D' } })
    )
    expect(section.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' })

    window.removeEventListener('arena:filter-exchange', listener)
    section.remove()
  })

  it('shows a working retry action instead of stale hard-coded sources', () => {
    mockUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('offline'),
      refetch: mockRefetch,
    })

    render(<ExchangePartners />)
    fireEvent.click(screen.getByRole('button', { name: 'Failed to load, tap to retry' }))
    expect(mockRefetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('centers the static empty state so the edge fade cannot clip it', () => {
    mockUseQuery.mockReturnValue({ data: [], isLoading: false, error: null, refetch: mockRefetch })

    render(<ExchangePartners />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('No data')
    const track = status.closest('.exchange-scroll-track') as HTMLElement
    expect(track.style.marginInline).toBe('auto')
    expect(track.style.animation).toBe('none')
  })

  it('keeps the scrolling track left-anchored when sources exist', () => {
    const { container } = render(<ExchangePartners />)
    const track = container.querySelector('.exchange-scroll-track') as HTMLElement
    expect(track.style.marginInline).toBe('')
  })
})
