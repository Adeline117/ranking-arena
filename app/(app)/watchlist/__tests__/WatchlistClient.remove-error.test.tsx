import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockGetUser = jest.fn()
const mockGetSession = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
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

const originalFetch = global.fetch
const originalMatchMedia = window.matchMedia

describe('WatchlistClient remove failure', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'viewer-1', email: 'viewer@example.com' } },
      error: null,
    })
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'access-token' } },
    })
    window.matchMedia = jest.fn().mockReturnValue({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })
  })

  afterEach(() => {
    global.fetch = originalFetch
    window.matchMedia = originalMatchMedia
    jest.restoreAllMocks()
  })

  it('keeps the trader and shows feedback when DELETE returns non-2xx', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return { ok: false, status: 503, json: async () => ({}) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          watchlist: [
            {
              source: 'binance',
              source_trader_id: 'alice-id',
              handle: 'Alice',
              created_at: '2026-07-17T00:00:00.000Z',
              roi: 12,
            },
          ],
        }),
      }
    }) as unknown as typeof fetch

    render(<WatchlistClient />)

    expect(await screen.findByText('Alice')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Watchlist update failed', 'error')
    )
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })
})
