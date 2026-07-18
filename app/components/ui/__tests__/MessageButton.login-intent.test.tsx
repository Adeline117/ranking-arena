import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { profileUserTarget, queueProfileActionLogin } from '@/lib/auth/profile-action-login'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockGetSession = jest.fn()
const mockApiRequest = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  },
}))

jest.mock('@/lib/api/client', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}))

import MessageButton from '../MessageButton'

describe('MessageButton login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/u/alice?tab=overview')
  })

  it('sends an anonymous message action through login with the exact profile route', () => {
    render(
      <MessageButton targetUserId="target-user" currentUserId={null} loginReturnPath="/u/alice" />
    )

    fireEvent.click(screen.getByRole('button', { name: 'directMessage' }))

    expect(mockPush).toHaveBeenCalledWith(
      '/login?returnUrl=%2Fu%2Falice%3Ftab%3Doverview%26resumeAction%3Dmessage-user'
    )
  })

  it('re-authenticates a missing/expired session without dropping the message target', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } })

    render(
      <MessageButton
        targetUserId="target-user"
        currentUserId="viewer-user"
        loginReturnPath="/u/alice"
      />
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
      target: profileUserTarget('target-user'),
      fallbackPath: '/u/alice',
    })
    window.history.replaceState(
      {},
      '',
      new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    )
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'access-token' } },
    })
    mockApiRequest.mockResolvedValue({
      success: true,
      data: { conversation_id: 'conversation-1' },
    })

    render(
      <MessageButton
        targetUserId="target-user"
        currentUserId="viewer-user"
        loginReturnPath="/u/alice"
      />
    )

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/messages/conversation-1'))
    expect(`${window.location.pathname}${window.location.search}`).toBe('/u/alice?tab=overview')
    expect(mockApiRequest).toHaveBeenCalledTimes(1)
  })
})
