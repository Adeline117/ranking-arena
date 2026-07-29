import { act, renderHook } from '@testing-library/react'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
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
    email: `${userId}@example.com`,
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

let mockAuth: MockAuth = pending(0)

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
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
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

import { useConversationAuth } from '../useConversationAuth'

describe('useConversationAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = pending(0)
  })

  it('does not expose a viewer while auth bootstrap is pending', () => {
    const { result, rerender } = renderHook(() => useConversationAuth('conversation-1'))

    expect(result.current.userId).toBeNull()
    expect(result.current.accessToken).toBeNull()
    expect(result.current.authChecked).toBe(false)

    mockAuth = signedOut(1)
    rerender()
    expect(result.current.authChecked).toBe(true)
  })

  it('preserves the exact conversation when an expired session requires login', async () => {
    mockAuth = signedOut(2)

    const { result } = renderHook(() => useConversationAuth('conversation/2'))

    await act(async () => {
      await result.current.ensureAuth()
    })

    expect(mockShowToast).toHaveBeenCalledWith('loginExpiredPleaseRelogin', 'error')
    expect(mockPush).toHaveBeenCalledWith('/login?returnUrl=%2Fmessages%2Fconversation%252F2')
  })

  it('switches user, token, and email as one canonical snapshot', () => {
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 3)
    const { result, rerender } = renderHook(() => useConversationAuth('conversation-3'))
    expect(result.current).toMatchObject({
      authChecked: true,
      userId: VIEWER_A,
      accessToken: 'access-token-a',
      email: `${VIEWER_A}@example.com`,
    })

    mockAuth = pending(4)
    rerender()
    expect(result.current).toMatchObject({
      authChecked: false,
      userId: null,
      accessToken: null,
      email: null,
    })

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 5)
    rerender()
    expect(result.current).toMatchObject({
      authChecked: true,
      userId: VIEWER_B,
      accessToken: 'access-token-b',
      email: `${VIEWER_B}@example.com`,
    })
  })
})
