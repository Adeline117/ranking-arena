import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

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
  viewerKey: 'pending' | 'anon' | `user:${string}`
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

function signedOut(generation: number): MockAuth {
  return {
    accessToken: null,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: generation,
    userId: null,
    viewerKey: 'anon',
  }
}

function pending(generation: number): MockAuth {
  return {
    accessToken: null,
    authChecked: false,
    email: null,
    loading: true,
    sessionGeneration: generation,
    userId: null,
    viewerKey: 'pending',
  }
}

let mockAuth: MockAuth = signedOut(1)

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
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

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/base', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))

jest.mock('../components/HeroSection', () => ({ HeroSection: () => null }))
jest.mock('../components/BenefitsSection', () => ({ BenefitsSection: () => null }))
jest.mock('../components/FaqSection', () => ({ FaqSection: () => null }))
jest.mock('../components/LinkedAccountsSidebar', () => ({
  LinkedAccountsSidebar: ({ linkedTraders }: { linkedTraders: Array<{ trader_id: string }> }) => (
    <div>{linkedTraders.map((trader) => trader.trader_id).join(',')}</div>
  ),
}))
jest.mock('../components/CexVerifyForm', () => ({
  CexVerifyForm: ({ onSuccess }: { onSuccess: () => void }) => (
    <button type="button" onClick={onSuccess}>
      cex verify form
    </button>
  ),
}))
jest.mock('../components/DexVerifyForm', () => ({ DexVerifyForm: () => null }))
jest.mock('../components/SearchSection', () => ({
  SearchSection: ({
    onSelect,
  }: {
    onSelect: (trader: { handle: string; source: string; source_trader_id: string }) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onSelect({
          handle: 'Alice Trader',
          source: 'binance',
          source_trader_id: 'account/42',
        })
      }
    >
      select trader
    </button>
  ),
}))

import ClaimPage from '../page'

function response(data: unknown, status = 200) {
  return {
    data,
    ok: status >= 200 && status < 300,
    status,
  }
}

type MockFetchResult = ReturnType<typeof response>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function linkedTrader(userId: string, traderId: string) {
  return {
    id: `${traderId}-link`,
    user_id: userId,
    trader_id: traderId,
    source: 'binance',
    label: null,
    is_primary: true,
    display_order: 0,
    verified_at: '2026-07-01T00:00:00.000Z',
    verification_method: 'api_key',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    stats: null,
  }
}

function linkedResponse(userId: string, traderId: string) {
  return response({
    success: true,
    data: {
      linked_traders: [linkedTrader(userId, traderId)],
      count: 1,
    },
  })
}

describe('claim page login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedOut(1)
    mockAuthedFetch.mockResolvedValue(
      response({ success: true, data: { linked_traders: [], count: 0 } })
    )
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('carries an anonymous search selection through login to verification', async () => {
    render(<ClaimPage />)

    fireEvent.click(screen.getByRole('button', { name: 'select trader' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Fclaim%3Ftrader%3Daccount%252F42%26source%3Dbinance%26handle%3DAlice%2BTrader%26step%3Dverify'
      )
    )
    expect(mockShowToast).toHaveBeenCalledWith('pleaseLoginFirst', 'warning')
  })

  it('waits for auth bootstrap before deciding whether a selection needs login', async () => {
    mockAuth = pending(2)
    const view = render(<ClaimPage />)

    fireEvent.click(screen.getByRole('button', { name: 'select trader' }))
    expect(mockPush).not.toHaveBeenCalled()

    mockAuth = signedIn(VIEWER_A, 'access-token-a', 3)
    view.rerender(<ClaimPage />)

    expect(await screen.findByText('cex verify form')).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('never displays a late linked-account response from the previous viewer', async () => {
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 4)
    const firstLoad = deferred<MockFetchResult>()
    mockAuthedFetch
      .mockReset()
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce(linkedResponse(VIEWER_B, 'trader-b'))
    const view = render(<ClaimPage />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenNthCalledWith(
      1,
      '/api/traders/linked',
      'GET',
      'access-token-a',
      undefined,
      15_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 4,
        signal: expect.any(AbortSignal),
      })
    )

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 5)
    view.rerender(<ClaimPage />)
    expect(await screen.findByText('trader-b')).toBeInTheDocument()

    await act(async () => {
      firstLoad.resolve(linkedResponse(VIEWER_A, 'trader-a'))
      await firstLoad.promise
    })

    expect(screen.queryByText('trader-a')).not.toBeInTheDocument()
    expect(screen.getByText('trader-b')).toBeInTheDocument()
  })

  it('cancels an old claim-success redirect when the viewer changes', () => {
    jest.useFakeTimers()
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 6)
    mockAuthedFetch.mockReset().mockReturnValue(new Promise(() => undefined))
    const view = render(<ClaimPage />)
    fireEvent.click(screen.getByRole('button', { name: 'select trader' }))
    fireEvent.click(screen.getByRole('button', { name: 'cex verify form' }))
    expect(screen.getByText('claimSubmitted')).toBeInTheDocument()

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 7)
    view.rerender(<ClaimPage />)
    act(() => {
      jest.advanceTimersByTime(2000)
    })

    expect(mockPush).not.toHaveBeenCalled()
  })
})
