import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { profileUserTarget, queueProfileActionLogin } from '@/lib/auth/profile-action-login'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockAuthedFetch = jest.fn()
const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'
const TARGET_A = '33333333-3333-4333-8333-333333333333'
const TARGET_B = '44444444-4444-4444-8444-444444444444'
const CONVERSATION_ID = '55555555-5555-4555-8555-555555555555'

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'anon' | `user:${string}`
}

function signedIn(userId: string, accessToken: string, sessionGeneration: number): MockAuth {
  return {
    accessToken,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}`,
  }
}

let mockAuth: MockAuth = signedIn(VIEWER_A, 'access-token-a', 1)

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
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
    viewer: {
      sessionGeneration: number
      userId: string
      viewerKey: string
    },
    auth: MockAuth
  ) =>
    auth.authChecked &&
    !auth.loading &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey &&
    auth.sessionGeneration === viewer.sessionGeneration,
}))

import MessageButton from '../MessageButton'

describe('MessageButton login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/u/alice?tab=overview')
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)
  })

  it('sends an anonymous message action through login with the exact profile route', () => {
    render(
      <MessageButton targetUserId={TARGET_A} currentUserId={null} loginReturnPath="/u/alice" />
    )

    fireEvent.click(screen.getByRole('button', { name: 'directMessage' }))

    expect(mockPush).toHaveBeenCalledWith(
      '/login?returnUrl=%2Fu%2Falice%3Ftab%3Doverview%26resumeAction%3Dmessage-user'
    )
  })

  it('re-authenticates a missing/expired session without dropping the message target', async () => {
    mockAuth = {
      accessToken: null,
      authChecked: true,
      email: null,
      loading: false,
      sessionGeneration: 2,
      userId: null,
      viewerKey: 'anon',
    }

    render(
      <MessageButton targetUserId={TARGET_A} currentUserId={VIEWER_A} loginReturnPath="/u/alice" />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Fu%2Falice%3Ftab%3Doverview%26resumeAction%3Dmessage-user'
      )
    )
    expect(mockShowToast).toHaveBeenCalledWith('loginExpiredPleaseRelogin', 'error')
  })

  it('resumes the exact pending conversation once after login', async () => {
    const href = queueProfileActionLogin({
      action: 'message-user',
      target: profileUserTarget(TARGET_A),
      fallbackPath: '/u/alice',
    })
    window.history.replaceState(
      {},
      '',
      new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    )
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        conversation_id: CONVERSATION_ID,
        sender_id: VIEWER_A,
        receiver_id: TARGET_A,
        can_message: true,
        is_mutual_follow: true,
        message_limit: null,
      },
    })

    render(
      <MessageButton targetUserId={TARGET_A} currentUserId={VIEWER_A} loginReturnPath="/u/alice" />
    )

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/messages/${CONVERSATION_ID}`))
    expect(`${window.location.pathname}${window.location.search}`).toBe('/u/alice?tab=overview')
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
  })

  it('consumes an anonymous message intent without messaging the target account itself', async () => {
    const href = queueProfileActionLogin({
      action: 'message-user',
      target: profileUserTarget(TARGET_A),
      fallbackPath: '/u/alice',
    })
    window.history.replaceState(
      {},
      '',
      new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    )
    mockAuth = signedIn(TARGET_A, 'target-token', 2)

    render(
      <MessageButton targetUserId={TARGET_A} currentUserId={TARGET_A} loginReturnPath="/u/alice" />
    )

    await waitFor(() =>
      expect(`${window.location.pathname}${window.location.search}`).toBe('/u/alice?tab=overview')
    )
    expect(window.sessionStorage).toHaveLength(0)
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('binds a click to the initiating viewer and ignores its result after an account switch', async () => {
    let resolveRequest:
      | ((value: { data: Record<string, unknown>; ok: boolean; status: number }) => void)
      | undefined
    mockAuthedFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve
        })
    )

    const { rerender } = render(<MessageButton targetUserId={TARGET_A} currentUserId={VIEWER_A} />)

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/messages/start',
      'POST',
      'access-token-a',
      { receiverId: TARGET_A },
      15_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      })
    )

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    rerender(<MessageButton targetUserId={TARGET_B} currentUserId={VIEWER_B} />)

    resolveRequest?.({
      ok: true,
      status: 200,
      data: {
        conversation_id: CONVERSATION_ID,
        sender_id: VIEWER_A,
        receiver_id: TARGET_A,
        can_message: true,
        is_mutual_follow: true,
        message_limit: null,
      },
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    expect(mockPush).not.toHaveBeenCalledWith(`/messages/${CONVERSATION_ID}`)
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('does not navigate when the server acknowledgement is not bound to the exact users', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        conversation_id: CONVERSATION_ID,
        sender_id: VIEWER_B,
        receiver_id: TARGET_A,
        can_message: true,
        is_mutual_follow: true,
        message_limit: null,
      },
    })

    render(<MessageButton targetUserId={TARGET_A} currentUserId={VIEWER_A} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('unexpectedError', 'error'))
    expect(mockPush).not.toHaveBeenCalledWith(`/messages/${CONVERSATION_ID}`)
  })
})
