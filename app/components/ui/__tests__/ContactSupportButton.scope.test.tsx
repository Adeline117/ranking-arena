import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockAuthedFetch = jest.fn()
const mockMaybeSingle = jest.fn()

const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'
const SUPPORT_USER_ID = '33333333-3333-4333-8333-333333333333'
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444'

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

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        ilike: () => ({
          maybeSingle: (...args: unknown[]) => mockMaybeSingle(...args),
        }),
      }),
    }),
  },
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

import ContactSupportButton from '../ContactSupportButton'

describe('ContactSupportButton viewer scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'token-a', 1)
    mockMaybeSingle.mockResolvedValue({ data: { id: SUPPORT_USER_ID } })
  })

  it('starts and accepts only a conversation bound to the initiating viewer', async () => {
    mockAuthedFetch.mockResolvedValue({
      data: {
        can_message: true,
        conversation_id: CONVERSATION_ID,
        receiver_id: SUPPORT_USER_ID,
        sender_id: VIEWER_A,
      },
      ok: true,
      status: 200,
    })

    render(<ContactSupportButton />)
    fireEvent.click(screen.getByRole('button', { name: 'contactSupport' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/messages/${CONVERSATION_ID}`))
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/messages/start',
      'POST',
      'token-a',
      { receiverId: SUPPORT_USER_ID },
      15_000,
      expect.objectContaining({
        expectedSessionGeneration: 1,
        expectedUserId: VIEWER_A,
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('does not start a conversation if the account changes during support lookup', async () => {
    let resolveLookup: ((value: { data: { id: string } }) => void) | undefined
    mockMaybeSingle.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve
        })
    )

    const { rerender } = render(<ContactSupportButton />)
    fireEvent.click(screen.getByRole('button', { name: 'contactSupport' }))

    mockAuth = signedIn(VIEWER_B, 'token-b', 2)
    rerender(<ContactSupportButton />)
    resolveLookup?.({ data: { id: SUPPORT_USER_ID } })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'contactSupport' })).toBeEnabled()
    )
    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('ignores an old acknowledgement after an account switch', async () => {
    let resolveRequest:
      | ((value: { data: Record<string, unknown>; ok: boolean; status: number }) => void)
      | undefined
    mockAuthedFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve
        })
    )

    const { rerender } = render(<ContactSupportButton />)
    fireEvent.click(screen.getByRole('button', { name: 'contactSupport' }))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    mockAuth = signedIn(VIEWER_B, 'token-b', 2)
    rerender(<ContactSupportButton />)
    resolveRequest?.({
      data: {
        can_message: true,
        conversation_id: CONVERSATION_ID,
        receiver_id: SUPPORT_USER_ID,
        sender_id: VIEWER_A,
      },
      ok: true,
      status: 200,
    })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'contactSupport' })).toBeEnabled()
    )
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
  })
})
