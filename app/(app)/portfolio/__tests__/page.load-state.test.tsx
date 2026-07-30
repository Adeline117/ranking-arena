import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockFetch = jest.fn()
const mockAuthedFetch = jest.fn()
const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockShowConfirm = jest.fn()
const mockRefreshSession = jest.fn()

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  loading: boolean
  refreshSession: typeof mockRefreshSession
  sessionGeneration: number
  userId: string | null
  viewerKey: string
}

let mockAuth: MockAuth

function authFor(userId: string, sessionGeneration: number): MockAuth {
  return {
    accessToken: `token-${userId}`,
    authChecked: true,
    loading: false,
    refreshSession: mockRefreshSession,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}`,
  }
}

const translations: Record<string, string> = {
  failedToLoad: 'Failed to load',
  openPositions: 'Open positions',
  portfolioAnalytics: 'Analytics',
  portfolioConnectExchange: 'Connect exchange',
  portfolioConnectedExchanges: 'Connected exchanges',
  portfolioEmptyTitle: 'Connect an exchange to track your portfolio',
  portfolioLoadFailed: 'Portfolio refresh failed; saved data was preserved.',
  portfolioRemove: 'Remove',
  portfolioRemoved: 'Removed',
  portfolioSync: 'Sync',
  portfolioSyncSuccess: 'Synced successfully',
  portfolioTitle: 'Portfolio',
  loadFailedRetryShort: 'Failed to load, please retry',
  retry: 'Retry',
  somethingWentWrong: 'Something went wrong',
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

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/lib/exchange/viewer-scope', () => ({
  captureExchangeViewer: (auth: MockAuth, expectedUserId: string | null) => {
    if (
      auth.loading ||
      !auth.authChecked ||
      !auth.userId ||
      auth.userId !== expectedUserId ||
      !auth.accessToken ||
      auth.viewerKey !== `user:${auth.userId}`
    ) {
      return null
    }
    return {
      accessToken: auth.accessToken,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
      viewerKey: auth.viewerKey,
    }
  },
  isExchangeViewerCurrent: (
    viewer: { sessionGeneration: number; userId: string; viewerKey: string },
    auth: MockAuth,
    expectedUserId: string | null
  ) =>
    auth.authChecked &&
    !auth.loading &&
    auth.userId === expectedUserId &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey &&
    auth.sessionGeneration === viewer.sessionGeneration,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: mockT }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/ui/Dialog', () => ({
  useDialog: () => ({ showConfirm: mockShowConfirm }),
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const connectedPortfolio = {
  id: 'portfolio-1',
  exchange: 'binance',
  label: 'Main account',
  created_at: '2026-07-17T00:00:00.000Z',
  is_active: true,
  current_equity: 200,
  current_pnl: 20,
  current_equity_generation: 1,
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
    mockAuth = authFor('user-1', 1)
    mockRefreshSession.mockResolvedValue(true)
    mockShowConfirm.mockResolvedValue(true)
    mockAuthedFetch.mockImplementation(
      async (
        url: string,
        method: string,
        token: string | null,
        body: Record<string, unknown> | undefined,
        _timeout: number,
        scope: { signal?: AbortSignal } | undefined
      ) => {
        const result = await mockFetch(url, {
          method,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: scope?.signal,
        })
        return {
          ok: result.ok,
          status: result.status,
          data: await result.json(),
        }
      }
    )
    mockFetch.mockResolvedValue(response({ data: [] }))
  })

  function switchViewer(userId: string, sessionGeneration: number) {
    mockAuth = authFor(userId, sessionGeneration)
  }

  it('fails closed on an inconsistent canonical session and offers a refresh', async () => {
    mockAuth = {
      ...authFor('user-1', 1),
      accessToken: null,
    }

    render(<PortfolioPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load, please retry')
    expect(mockPush).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(mockRefreshSession).toHaveBeenCalledTimes(1))
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('redirects only after canonical auth resolves signed out', async () => {
    mockAuth = {
      ...authFor('user-1', 1),
      accessToken: null,
      userId: null,
      viewerKey: 'anon',
    }

    render(<PortfolioPage />)

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/login?redirect=/portfolio'))
    expect(screen.getByTestId('portfolio-overview')).toHaveTextContent('Loading portfolio')
    expect(mockFetch).not.toHaveBeenCalled()
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
    jest.spyOn(Date, 'now').mockReturnValue(100_000)

    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/portfolio/sync' && init?.method === 'POST') {
        return Promise.resolve(
          response({
            data: {
              portfolio_id: connectedPortfolio.id,
              synced: true,
              viewer_id: 'user-1',
            },
          })
        )
      }
      if (mode === 'failed' && url === '/api/portfolio') {
        return Promise.resolve(response({ error: 'Service unavailable' }, 503))
      }
      if (url === '/api/portfolio') {
        return Promise.resolve(
          response({
            data: [
              {
                ...connectedPortfolio,
                current_equity: mode === 'recovered' ? 300 : 200,
              },
            ],
          })
        )
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

  it('clears A data immediately, aborts A reads, and only publishes B after an account switch', async () => {
    const pendingA = new Map<string, ReturnType<typeof deferred<Response>>>()
    const aSignals: AbortSignal[] = []

    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const token = new Headers(init?.headers).get('Authorization')
      if (token === 'Bearer token-user-1') {
        const request = deferred<Response>()
        pendingA.set(url, request)
        if (init?.signal) aSignals.push(init.signal)
        return request.promise
      }
      if (token === 'Bearer token-user-2') {
        if (url === '/api/portfolio') {
          return Promise.resolve(
            response({ data: [{ ...connectedPortfolio, id: 'portfolio-b', label: 'B account' }] })
          )
        }
        if (url === '/api/portfolio/positions') {
          return Promise.resolve(
            response({ data: [{ ...position(200), id: 'position-b', symbol: 'ETHUSDT' }] })
          )
        }
        if (url === '/api/portfolio/snapshots') return Promise.resolve(response({ data: [] }))
      }
      throw new Error(`Unexpected fetch: ${url} (${token})`)
    })

    const view = render(<PortfolioPage />)
    await waitFor(() => expect(pendingA.size).toBe(3))

    switchViewer('user-2', 2)
    view.rerender(<PortfolioPage />)

    expect(screen.queryByText('BTCUSDT')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('position-list')).toHaveTextContent('ETHUSDT'))
    expect(aSignals).toHaveLength(3)
    expect(aSignals.every((signal) => signal.aborted)).toBe(true)

    pendingA.get('/api/portfolio')?.resolve(response({ data: [connectedPortfolio] }))
    pendingA.get('/api/portfolio/positions')?.resolve(response({ data: [position(100)] }))
    pendingA.get('/api/portfolio/snapshots')?.resolve(response({ data: [] }))

    await waitFor(() => expect(screen.getByTestId('position-list')).toHaveTextContent('ETHUSDT'))
    expect(screen.queryByText('BTCUSDT')).not.toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('does not start a destructive delete after the confirmation viewer changes', async () => {
    const confirmation = deferred<boolean>()
    mockShowConfirm.mockReturnValueOnce(confirmation.promise)
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/portfolio') {
        return Promise.resolve(response({ data: [connectedPortfolio] }))
      }
      return Promise.resolve(response({ data: [] }))
    })

    const view = render(<PortfolioPage />)
    await screen.findByRole('button', { name: 'Remove' })

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(mockShowConfirm).toHaveBeenCalledTimes(1)

    switchViewer('user-2', 2)
    view.rerender(<PortfolioPage />)
    confirmation.resolve(true)

    await waitFor(() => {
      expect(mockAuthedFetch.mock.calls.filter((call) => call[1] === 'DELETE')).toHaveLength(0)
    })
    expect(mockShowToast).not.toHaveBeenCalledWith('Removed', 'success')
  })
})
