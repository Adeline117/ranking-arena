import { act, renderHook, waitFor } from '@testing-library/react'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockGetAuthSession = jest.fn()
const mockRefreshAuthToken = jest.fn()
const mockUnsubscribe = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/lib/auth', () => ({
  getAuthSession: (...args: unknown[]) => mockGetAuthSession(...args),
  refreshAuthToken: (...args: unknown[]) => mockRefreshAuthToken(...args),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: mockUnsubscribe } },
      })),
    },
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
  })

  it('finishes bootstrap as logged out when the session check fails', async () => {
    mockGetAuthSession.mockRejectedValueOnce(new Error('storage unavailable'))

    const { result } = renderHook(() => useConversationAuth('conversation-1'))

    await waitFor(() => expect(result.current.authChecked).toBe(true))
    expect(result.current.userId).toBeNull()
    expect(result.current.accessToken).toBeNull()
  })

  it('preserves the exact conversation when an expired session requires login', async () => {
    mockGetAuthSession.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    mockRefreshAuthToken.mockResolvedValueOnce(null)

    const { result } = renderHook(() => useConversationAuth('conversation/2'))
    await waitFor(() => expect(result.current.authChecked).toBe(true))

    await act(async () => {
      await result.current.ensureAuth()
    })

    expect(mockShowToast).toHaveBeenCalledWith('loginExpiredPleaseRelogin', 'error')
    expect(mockPush).toHaveBeenCalledWith('/login?returnUrl=%2Fmessages%2Fconversation%252F2')
  })
})
