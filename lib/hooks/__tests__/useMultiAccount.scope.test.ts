jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      getUser: jest.fn(),
      refreshSession: jest.fn(),
      signOut: jest.fn(),
      setSession: jest.fn(),
    },
  },
}))
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }))
jest.mock('@/lib/premium/hooks', () => ({ usePremium: () => ({ isPremium: false }) }))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ signOut: jest.fn() }),
}))

import { invalidateStoredRefreshToken } from '../useMultiAccount'

const mockSharedAuth = (
  jest.requireMock('@/lib/supabase/client') as {
    supabase: { auth: Record<'refreshSession' | 'signOut' | 'setSession', jest.Mock> }
  }
).supabase.auth
const mockCreateClient = (jest.requireMock('@supabase/supabase-js') as { createClient: jest.Mock })
  .createClient
const mockIsolatedRefreshSession = jest.fn()
const mockIsolatedSignOut = jest.fn()

describe('multi-account refresh-token revocation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateClient.mockReturnValue({
      auth: {
        refreshSession: mockIsolatedRefreshSession,
        signOut: mockIsolatedSignOut,
      },
    })
  })

  it('uses a non-persistent isolated client without touching the active session client', async () => {
    mockIsolatedRefreshSession.mockResolvedValue({
      data: { session: { access_token: 'rotated-access' } },
      error: null,
    })
    mockIsolatedSignOut.mockResolvedValue({ error: null })

    await invalidateStoredRefreshToken('stored-refresh-token')

    expect(mockCreateClient).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        auth: expect.objectContaining({
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        }),
      })
    )
    expect(mockIsolatedRefreshSession).toHaveBeenCalledWith({
      refresh_token: 'stored-refresh-token',
    })
    expect(mockIsolatedSignOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(mockSharedAuth.refreshSession).not.toHaveBeenCalled()
    expect(mockSharedAuth.signOut).not.toHaveBeenCalled()
    expect(mockSharedAuth.setSession).not.toHaveBeenCalled()
  })
})
