import { act, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const VIEWER_A = '10000000-0000-4000-8000-000000000001'
const VIEWER_B = '20000000-0000-4000-8000-000000000002'
const POST_ID = '30000000-0000-4000-8000-000000000003'
const RECIPIENT_ID = '40000000-0000-4000-8000-000000000004'
const TIP_ID = '50000000-0000-4000-8000-000000000005'
const SESSION_ID = 'cs_tip_atomic'

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'anon' | `user:${string}`
}

function signedIn(userId: string, generation: number): MockAuth {
  return {
    accessToken: `token-${userId}`,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

let mockAuth: MockAuth = signedIn(VIEWER_A, 1)
let mockSearch: Record<string, string | null> = { session_id: SESSION_ID }
const mockAuthedFetch = jest.fn()
const mockRouterPush = jest.fn()
const mockTrackEvent = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useSearchParams: () => ({ get: (key: string) => mockSearch[key] ?? null }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          tipSentAmount: 'You sent {amount}',
          redirectingCountdown: 'Redirecting in {seconds}',
        }) as Record<string, string>
      )[key] ?? key,
  }),
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

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import TipSuccessPage from '../page'

function verifiedReceipt(viewerId = VIEWER_A, overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      tip: {
        tip_id: TIP_ID,
        session_id: SESSION_ID,
        from_user_id: viewerId,
        post_id: POST_ID,
        to_user_id: RECIPIENT_ID,
        amount_cents: 500,
        currency: 'usd',
        status: 'completed',
        completed_at: '2026-08-03T12:00:00.000Z',
        ...overrides,
      },
    },
    meta: { timestamp: '2026-08-03T12:00:01.000Z' },
  }
}

const pendingResponse = {
  ok: false,
  status: 409,
  data: {
    success: false,
    code: 'TIP_PAYMENT_PENDING',
    error: 'Tip payment confirmation is still processing.',
  },
}

describe('Tip success durable payment truth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    mockAuth = signedIn(VIEWER_A, 1)
    mockSearch = { session_id: SESSION_ID }
  })

  it('does not treat amount, handle, or post URL fields as success evidence', async () => {
    mockSearch = {
      session_id: null,
      amount: '500',
      handle: 'creator',
      post_id: POST_ID,
    }

    render(<TipSuccessPage />)

    expect(await screen.findByRole('heading', { name: 'verificationFailed' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'tipSuccess' })).not.toBeInTheDocument()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('polls bounded pending authority and renders success only from the exact receipt', async () => {
    jest.useFakeTimers()
    mockAuthedFetch
      .mockResolvedValueOnce(pendingResponse)
      .mockResolvedValueOnce({ ok: true, status: 200, data: verifiedReceipt() })

    render(<TipSuccessPage />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: 'tipSuccess' })).not.toBeInTheDocument()

    await act(async () => {
      await jest.advanceTimersByTimeAsync(800)
    })

    expect(screen.getByRole('heading', { name: 'tipSuccess' })).toBeInTheDocument()
    expect(screen.getByText('You sent $5.00')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'backToPost' })).toHaveAttribute(
      'href',
      `/post/${POST_ID}`
    )
    expect(mockAuthedFetch).toHaveBeenLastCalledWith(
      '/api/tip/verify-session',
      'POST',
      `token-${VIEWER_A}`,
      { session_id: SESSION_ID },
      15_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      })
    )
    jest.useRealTimers()
  })

  it('rejects an expanded or mismatched 200 response', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...verifiedReceipt(), receipt_emailed: true },
    })

    render(<TipSuccessPage />)

    expect(await screen.findByRole('heading', { name: 'verificationFailed' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'tipSuccess' })).not.toBeInTheDocument()
  })

  it('aborts the old viewer request and ignores its late successful receipt', async () => {
    let resolveOld:
      | ((value: { ok: boolean; status: number; data: Record<string, unknown> }) => void)
      | undefined
    mockAuthedFetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          })
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        data: {
          success: false,
          code: 'TIP_PAYMENT_NOT_FOUND',
          error: 'Tip payment was not found for this account.',
        },
      })

    const { rerender } = render(<TipSuccessPage />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    const oldSignal = mockAuthedFetch.mock.calls[0][5].signal as AbortSignal

    mockAuth = signedIn(VIEWER_B, 2)
    rerender(<TipSuccessPage />)

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(oldSignal.aborted).toBe(true)
    resolveOld?.({ ok: true, status: 200, data: verifiedReceipt(VIEWER_A) })

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'verificationFailed' })).toBeInTheDocument()
    )
    expect(screen.queryByRole('heading', { name: 'tipSuccess' })).not.toBeInTheDocument()
  })

  it('contains no browser database fallback or receipt-email claim', () => {
    const page = readFileSync(join(process.cwd(), 'app/(app)/tip/success/page.tsx'), 'utf8')

    expect(page).toContain("'/api/tip/verify-session'")
    expect(page).not.toContain(".from('tips')")
    expect(page).not.toContain("searchParams.get('amount')")
    expect(page).not.toContain("searchParams.get('handle')")
    expect(page).not.toContain("t('receiptEmailed')")
  })
})
