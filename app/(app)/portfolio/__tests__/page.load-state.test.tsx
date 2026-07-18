import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockFetch = jest.fn()
const mockGetUser = jest.fn()
const mockGetSession = jest.fn()
const mockPush = jest.fn()
const mockShowToast = jest.fn()

const translations: Record<string, string> = {
  failedToLoad: 'Failed to load',
  openPositions: 'Open positions',
  portfolioAnalytics: 'Analytics',
  portfolioConnectExchange: 'Connect exchange',
  portfolioConnectedExchanges: 'Connected exchanges',
  portfolioEmptyTitle: 'Connect an exchange to track your portfolio',
  portfolioLoadFailed: 'Portfolio refresh failed; saved data was preserved.',
  portfolioRemove: 'Remove',
  portfolioSync: 'Sync',
  portfolioSyncSuccess: 'Synced successfully',
  portfolioTitle: 'Portfolio',
  retry: 'Retry',
}
const mockT = (key: string) => translations[key] ?? key

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function MockDynamicComponent() {
      return null
    },
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: mockT }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/ui/Dialog', () => ({
  useDialog: () => ({ showConfirm: jest.fn() }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'X-CSRF-Token': 'csrf-token' }),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

jest.mock('@/app/components/ui/PageHeader', () => ({
  __esModule: true,
  default: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {actions}
    </header>
  ),
}))

jest.mock('@/app/components/ui/ErrorState', () => ({
  __esModule: true,
  default: ({
    title,
    description,
    retry,
  }: {
    title: string
    description: string
    retry: () => void
  }) => (
    <section role="alert">
      <h2>{title}</h2>
      <p>{description}</p>
      <button onClick={retry}>Retry</button>
    </section>
  ),
}))

jest.mock('@/app/components/portfolio/PortfolioOverview', () => ({
  __esModule: true,
  default: ({ totalEquity, isLoading }: { totalEquity: number; isLoading?: boolean }) => (
    <div data-testid="portfolio-overview">
      {isLoading ? 'Loading portfolio' : `Equity ${totalEquity}`}
    </div>
  ),
}))

jest.mock('@/app/components/portfolio/PositionList', () => ({
  __esModule: true,
  default: ({
    positions,
    isLoading,
  }: {
    positions: Array<{ symbol: string }>
    isLoading?: boolean
  }) => (
    <div data-testid="position-list">
      {isLoading ? 'Loading positions' : positions.map((position) => position.symbol).join(',')}
    </div>
  ),
}))

import PortfolioPage from '../page'

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

const connectedPortfolio = {
  id: 'portfolio-1',
  exchange: 'binance',
  label: 'Main account',
  created_at: '2026-07-17T00:00:00.000Z',
}

function position(markPrice: number) {
  return {
    id: 'position-1',
    symbol: 'BTCUSDT',
    side: 'long',
    entry_price: 90,
    mark_price: markPrice,
    size: 2,
    pnl: 20,
    pnl_pct: 10,
    leverage: 2,
    updated_at: '2026-07-17T00:00:00.000Z',
  }
}

describe('PortfolioPage load state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockFetch
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'access-token' } },
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('shows a persistent retry error instead of a false empty or $0 portfolio', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/portfolio') {
        return Promise.resolve(response({ error: 'Service unavailable' }, 503))
      }
      return Promise.resolve(response({ data: [] }))
    })

    render(<PortfolioPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Portfolio refresh failed; saved data was preserved.'
    )
    expect(
      screen.queryByText('Connect an exchange to track your portfolio')
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId('portfolio-overview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('position-list')).not.toBeInTheDocument()
    expect(mockShowToast).toHaveBeenCalledWith(
      'Portfolio refresh failed; saved data was preserved.',
      'error'
    )
  })

  it('keeps last-good data through a failed refresh and replaces it only after retry succeeds', async () => {
    let mode: 'initial' | 'failed' | 'recovered' = 'initial'
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000)

    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/portfolio/sync' && init?.method === 'POST') {
        return Promise.resolve(response({ data: { synced: true } }))
      }
      if (mode === 'failed' && url === '/api/portfolio') {
        return Promise.resolve(response({ error: 'Service unavailable' }, 503))
      }
      if (url === '/api/portfolio') {
        return Promise.resolve(response({ data: [connectedPortfolio] }))
      }
      if (url === '/api/portfolio/positions') {
        return Promise.resolve(response({ data: [position(mode === 'recovered' ? 150 : 100)] }))
      }
      if (url === '/api/portfolio/snapshots') {
        return Promise.resolve(response({ data: [] }))
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(<PortfolioPage />)

    await waitFor(() =>
      expect(screen.getByTestId('portfolio-overview')).toHaveTextContent('Equity 200')
    )
    expect(screen.getByTestId('position-list')).toHaveTextContent('BTCUSDT')

    mode = 'failed'
    now.mockReturnValue(131_000)
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('portfolio-overview')).toHaveTextContent('Equity 200')
    expect(screen.getByTestId('position-list')).toHaveTextContent('BTCUSDT')

    mode = 'recovered'
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByTestId('portfolio-overview')).toHaveTextContent('Equity 300')
    expect(screen.getByTestId('position-list')).toHaveTextContent('BTCUSDT')
  })
})
