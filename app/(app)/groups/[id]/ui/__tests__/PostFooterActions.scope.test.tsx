import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockShowToast = jest.fn()
const mockAuthedFetch = jest.fn()

const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'
const POST_ID = '33333333-3333-4333-8333-333333333333'

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

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
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

import PostFooterActions from '../PostFooterActions'

const post = {
  id: POST_ID,
  author_handle: 'creator',
  comment_count: 0,
  like_count: 0,
}

describe('PostFooterActions tip viewer scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'token-a', 1)
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: jest.fn(),
    })
  })

  it('closes an old tip intent synchronously when the viewer changes', () => {
    const { rerender } = render(<PostFooterActions post={post} />)
    fireEvent.click(screen.getByRole('button', { name: 'tip' }))
    expect(screen.getByRole('button', { name: 'pay $1' })).toBeInTheDocument()

    mockAuth = signedIn(VIEWER_B, 'token-b', 2)
    rerender(<PostFooterActions post={post} />)

    expect(screen.queryByRole('button', { name: 'pay $1' })).not.toBeInTheDocument()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('binds checkout creation to the initiating viewer and ignores an old result', async () => {
    let resolveRequest:
      | ((value: { data: Record<string, unknown>; ok: boolean; status: number }) => void)
      | undefined
    mockAuthedFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve
        })
    )

    const { rerender } = render(<PostFooterActions post={post} />)
    fireEvent.click(screen.getByRole('button', { name: 'tip' }))
    fireEvent.click(screen.getByRole('button', { name: 'pay $1' }))

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/tip/checkout',
      'POST',
      'token-a',
      { amount_cents: 100, post_id: POST_ID },
      20_000,
      expect.objectContaining({
        expectedSessionGeneration: 1,
        expectedUserId: VIEWER_A,
        signal: expect.any(AbortSignal),
      })
    )

    mockAuth = signedIn(VIEWER_B, 'token-b', 2)
    rerender(<PostFooterActions post={post} />)
    resolveRequest?.({
      data: {
        sessionId: 'cs_tip_atomic',
        url: 'https://checkout.stripe.com/c/pay/cs_tip_atomic',
      },
      ok: true,
      status: 200,
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'tip' })).toBeEnabled())
    expect(mockShowToast).not.toHaveBeenCalled()
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a successful response that is not a verified Stripe checkout URL', async () => {
    mockAuthedFetch.mockResolvedValue({
      data: {
        sessionId: 'cs_tip_atomic',
        url: 'https://evil.example/c/pay/cs_tip_atomic',
      },
      ok: true,
      status: 200,
    })

    render(<PostFooterActions post={post} />)
    fireEvent.click(screen.getByRole('button', { name: 'tip' }))
    fireEvent.click(screen.getByRole('button', { name: 'pay $1' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('createPaymentFailed', 'error'))
  })
})
