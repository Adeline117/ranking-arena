jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
  },
}))
jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    getValidToken: jest.fn(),
    forceRefresh: jest.fn(),
  },
}))

import { getAuthSession, refreshAuthToken } from '@/lib/auth'
import {
  __resetViewerScopeForTests,
  getViewerScope,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockGetSession = (
  jest.requireMock('@/lib/supabase/client') as { supabase: { auth: { getSession: jest.Mock } } }
).supabase.auth.getSession
const mockCoordinator = (
  jest.requireMock('@/lib/auth/token-refresh') as {
    tokenRefreshCoordinator: { getValidToken: jest.Mock; forceRefresh: jest.Mock }
  }
).tokenRefreshCoordinator

function session(userId: string, accessToken: string) {
  return {
    user: { id: userId },
    access_token: accessToken,
  }
}

describe('legacy auth helpers viewer scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
  })

  it('returns a token and principal only when both belong to the captured epoch', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    mockCoordinator.getValidToken.mockResolvedValue('token-a')
    mockGetSession.mockResolvedValue({ data: { session: session('user-a', 'token-a') } })

    await expect(getAuthSession()).resolves.toEqual({
      userId: 'user-a',
      accessToken: 'token-a',
    })
    expect(mockCoordinator.getValidToken).toHaveBeenCalledWith({
      expectedUserId: 'user-a',
      sessionGeneration: scope.sessionGeneration,
    })
  })

  it('rejects an A token if the shared session becomes B before principal readback', async () => {
    synchronizeViewerScope(true, 'user-a')
    mockCoordinator.getValidToken.mockResolvedValue('token-a')
    mockGetSession.mockImplementation(async () => {
      synchronizeViewerScope(true, 'user-b')
      return { data: { session: session('user-b', 'token-b') } }
    })

    await expect(getAuthSession()).resolves.toBeNull()
    expect(getViewerScope().userId).toBe('user-b')
  })

  it('rejects a refreshed token after its viewer epoch changes', async () => {
    synchronizeViewerScope(true, 'user-a')
    mockCoordinator.forceRefresh.mockImplementation(async () => {
      synchronizeViewerScope(true, 'user-b')
      return 'token-a2'
    })

    await expect(refreshAuthToken()).resolves.toBeNull()
    expect(mockGetSession).not.toHaveBeenCalled()
  })
})
