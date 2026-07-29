import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockAuthedFetch = jest.fn()
const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'anon' | `user:${string}`
}

function signedIn(userId: string, token: string, generation: number): MockAuth {
  return {
    accessToken: token,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

let mockAuth: MockAuth = signedIn(VIEWER_A, 'token-a', 1)

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/app/(app)/settings/hooks/settings-viewer-scope', () => ({
  captureSettingsViewer: (auth: MockAuth) => {
    if (
      auth.loading ||
      !auth.authChecked ||
      !auth.userId ||
      !auth.accessToken ||
      auth.viewerKey !== `user:${auth.userId}`
    ) {
      return null
    }
    return {
      accessToken: auth.accessToken,
      email: auth.email,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
      viewerKey: auth.viewerKey,
    }
  },
  isSettingsViewerCurrent: (
    viewer: { sessionGeneration: number; userId: string; viewerKey: string },
    auth: MockAuth
  ) =>
    auth.authChecked &&
    !auth.loading &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey &&
    auth.sessionGeneration === viewer.sessionGeneration,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          watchlistActions: 'Actions',
          watchlistConfirmNo: 'No',
          watchlistConfirmYes: 'Yes',
          watchlistError: 'Watchlist update failed',
          watchlistRemove: 'Remove',
          watchlistSaved: 'saved',
          watchlistShown: 'shown',
        }) as Record<string, string>
      )[key] || key,
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/layout/FloatingActionButton', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/PageHeader', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/LoadingSkeleton', () => ({
  __esModule: true,
  default: () => <div>Loading watchlist</div>,
}))

jest.mock('@/app/components/ui/EmptyState', () => ({
  __esModule: true,
  default: () => <div>Empty watchlist</div>,
}))

jest.mock('@/app/components/ui/ErrorState', () => ({
  __esModule: true,
  default: () => <div>Watchlist load error</div>,
}))

import WatchlistClient from '../WatchlistClient'

const originalMatchMedia = window.matchMedia
const alice = {
  source: 'binance',
  source_trader_id: 'alice-id',
  handle: 'Alice',
  created_at: '2026-07-17T00:00:00.000Z',
  roi: 12,
}

describe('WatchlistClient remove failure', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'token-a', 1)
    window.matchMedia = jest.fn().mockReturnValue({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    jest.restoreAllMocks()
  })

  it('keeps the trader and shows feedback when DELETE returns non-2xx', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockAuthedFetch.mockImplementation(async (_url: string, method: string) => {
      if (method === 'DELETE') {
        return { data: {}, ok: false, status: 503 }
      }
      return {
        data: { watchlist: [alice] },
        ok: true,
        status: 200,
      }
    })

    render(<WatchlistClient />)

    expect(await screen.findByText('Alice')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Watchlist update failed', 'error')
    )
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })

  it('drops an old delete result and remounts private state after an account switch', async () => {
    let resolveDelete:
      | ((value: { data: { watchlist: unknown[] }; ok: boolean; status: number }) => void)
      | undefined
    mockAuthedFetch.mockImplementation((_url: string, method: string, token: string) => {
      if (method === 'DELETE') {
        return new Promise((resolve) => {
          resolveDelete = resolve
        })
      }
      return Promise.resolve({
        data: {
          watchlist:
            token === 'token-a'
              ? [alice]
              : [
                  {
                    ...alice,
                    handle: 'Bob private copy',
                  },
                ],
        },
        ok: true,
        status: 200,
      })
    })

    const { rerender } = render(<WatchlistClient />)
    expect(await screen.findByText('Alice')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    await waitFor(() =>
      expect(mockAuthedFetch).toHaveBeenCalledWith(
        '/api/watchlist',
        'DELETE',
        'token-a',
        { source: 'binance', source_trader_id: 'alice-id' },
        15_000,
        expect.objectContaining({
          expectedSessionGeneration: 1,
          expectedUserId: VIEWER_A,
          signal: expect.any(AbortSignal),
        })
      )
    )

    mockAuth = signedIn(VIEWER_B, 'token-b', 2)
    rerender(<WatchlistClient />)
    expect(await screen.findByText('Bob private copy')).toBeInTheDocument()

    resolveDelete?.({ data: { watchlist: [] }, ok: true, status: 200 })
    await waitFor(() => expect(screen.getByText('Bob private copy')).toBeInTheDocument())
    expect(mockShowToast).not.toHaveBeenCalled()
  })
})
