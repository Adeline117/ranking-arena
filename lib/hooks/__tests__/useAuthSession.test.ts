/**
 * useAuthSession hook tests
 * Tests categorizeError utility (pure function, no complex mocks needed)
 */

const mockGetSession = jest.fn().mockResolvedValue({ data: { session: null } })
const mockRefreshSession = jest.fn().mockResolvedValue({ data: { session: null }, error: null })
const mockSignOut = jest.fn().mockResolvedValue({})
let mockAuthStateCallback: ((event: string, session: unknown) => void) | undefined
const mockOnAuthStateChange = jest.fn((callback: (event: string, session: unknown) => void) => {
  mockAuthStateCallback = callback
  return { data: { subscription: { unsubscribe: jest.fn() } } }
})

// Mock supabase before imports
jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: mockOnAuthStateChange,
      refreshSession: mockRefreshSession,
      signOut: mockSignOut,
    },
  },
}))

import { act, renderHook, waitFor } from '@testing-library/react'
import { useAuthSession } from '../useAuthSession'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { getViewerScope } from '@/lib/auth/viewer-scope'
import { AUTH_OPERATION_STORAGE_KEY, AUTH_STORAGE_KEY } from '@/lib/auth/session-operation'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('useAuthSession', () => {
  it('does not let a stale initial-session rejection resolve a newer transition as anonymous', async () => {
    const initialRead = deferred<{ data: { session: null } }>()
    mockGetSession.mockReturnValueOnce(initialRead.promise)
    const { result } = renderHook(() => useAuthSession())
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled())

    let transitionGeneration = 0
    act(() => {
      transitionGeneration = tokenRefreshCoordinator.beginIdentityTransition('user-b')
    })
    await act(async () => {
      initialRead.reject(new Error('stale initialization failure'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getViewerScope().viewerKey).toBe('pending')
    expect(result.current.viewerKey).toBe('pending')
    expect(result.current.authChecked).toBe(false)
    expect(result.current.loading).toBe(true)

    act(() => {
      tokenRefreshCoordinator.completeIdentityTransition(transitionGeneration, 'user-b')
      mockAuthStateCallback?.('SIGNED_IN', {
        user: { id: 'user-b', email: 'b@example.test' },
        access_token: 'token-b',
        refresh_token: 'refresh-b',
      })
      // A stale SIGNED_OUT emitted by the superseded A writer must not erase B.
      mockAuthStateCallback?.('SIGNED_OUT', null)
    })
    await waitFor(() => expect(result.current.viewerKey).toBe('user:user-b'))
    await act(async () => tokenRefreshCoordinator.signOut())
  })

  it('starts in loading state', () => {
    const { result } = renderHook(() => useAuthSession())
    // Initially should not be logged in
    expect(result.current.isLoggedIn).toBe(false)
    expect(result.current.userId).toBeNull()
  })

  it('resolves a cross-tab identity lease only when the matching session storage event arrives', async () => {
    const { result } = renderHook(() => useAuthSession())
    await waitFor(() => expect(mockAuthStateCallback).toBeDefined())
    act(() => {
      const generation = tokenRefreshCoordinator.beginIdentityTransition('user-a')
      tokenRefreshCoordinator.completeIdentityTransition(generation, 'user-a')
      mockAuthStateCallback?.('SIGNED_IN', {
        user: { id: 'user-a', email: 'a@example.test' },
        access_token: 'token-a',
        refresh_token: 'refresh-a',
      })
    })
    await waitFor(() => expect(result.current.userId).toBe('user-a'))

    const operation = {
      id: 'cross-tab-user-b',
      expectedUserId: 'user-b',
      targetKnown: true,
      identityTransition: true,
    }
    window.localStorage.setItem(AUTH_OPERATION_STORAGE_KEY, JSON.stringify(operation))
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: AUTH_OPERATION_STORAGE_KEY,
          newValue: JSON.stringify(operation),
        })
      )
    })
    await waitFor(() => expect(result.current.viewerKey).toBe('pending'))

    const sessionB = {
      user: { id: 'user-b', email: 'b@example.test' },
      access_token: 'token-b',
      refresh_token: 'refresh-b',
    }
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionB))
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: AUTH_STORAGE_KEY,
          newValue: JSON.stringify(sessionB),
        })
      )
    })

    await waitFor(() => expect(result.current.userId).toBe('user-b'))
    expect(result.current.accessToken).toBe('token-b')

    // A delayed operation event from an older tab must not move B back to
    // pending after B already owns the canonical operation key.
    const staleLogout = {
      id: 'stale-cross-tab-logout',
      expectedUserId: null,
      targetKnown: true,
      identityTransition: true,
    }
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: AUTH_OPERATION_STORAGE_KEY,
          newValue: JSON.stringify(staleLogout),
        })
      )
    })
    expect(result.current.userId).toBe('user-b')
    expect(result.current.viewerKey).toBe('user:user-b')
    await act(async () => tokenRefreshCoordinator.signOut())
  })

  describe('categorizeError', () => {
    it('categorizes 401 as NOT_AUTHENTICATED', () => {
      const { result } = renderHook(() => useAuthSession())
      const err = result.current.categorizeError(401)
      expect(err).toEqual({
        type: 'NOT_AUTHENTICATED',
        message: 'Please login first',
      })
    })

    it('categorizes 401 with expired message as TOKEN_EXPIRED', () => {
      const { result } = renderHook(() => useAuthSession())
      const err = result.current.categorizeError(401, { error: 'Token expired' })
      expect(err).toEqual({
        type: 'TOKEN_EXPIRED',
        message: '登录已过期，请重新登录',
      })
    })

    it('categorizes 403 as FORBIDDEN', () => {
      const { result } = renderHook(() => useAuthSession())
      const err = result.current.categorizeError(403)
      expect(err?.type).toBe('FORBIDDEN')
    })

    it('returns null for non-auth errors', () => {
      const { result } = renderHook(() => useAuthSession())
      expect(result.current.categorizeError(404)).toBeNull()
      expect(result.current.categorizeError(500)).toBeNull()
    })
  })

  describe('getAuthHeaders', () => {
    it('returns null when not logged in', () => {
      const { result } = renderHook(() => useAuthSession())
      expect(result.current.getAuthHeaders()).toBeNull()
    })
  })

  describe('requireAuth', () => {
    it('returns null when not logged in', () => {
      const { result } = renderHook(() => useAuthSession())
      // Prevent redirect
      const headers = result.current.requireAuth({ redirectToLogin: false })
      expect(headers).toBeNull()
    })
  })

  it('fails synchronous auth getters closed in the same tick that A enters pending', async () => {
    const { result } = renderHook(() => useAuthSession())
    await waitFor(() => expect(mockAuthStateCallback).toBeDefined())
    act(() => {
      const generation = tokenRefreshCoordinator.beginIdentityTransition('user-a')
      tokenRefreshCoordinator.completeIdentityTransition(generation, 'user-a')
      mockAuthStateCallback?.('SIGNED_IN', {
        user: { id: 'user-a', email: 'a@example.test' },
        access_token: 'token-a',
        refresh_token: 'refresh-a',
      })
    })
    await waitFor(() => expect(result.current.userId).toBe('user-a'))
    const getAuthHeaders = result.current.getAuthHeaders
    const requireAuth = result.current.requireAuth

    let transitionGeneration = 0
    act(() => {
      transitionGeneration = tokenRefreshCoordinator.beginIdentityTransition('user-b')
      // These assertions run before React can rerender or run stateRef's effect.
      expect(getAuthHeaders()).toBeNull()
      expect(requireAuth({ redirectToLogin: false })).toBeNull()
    })

    act(() => {
      tokenRefreshCoordinator.completeIdentityTransition(transitionGeneration, 'user-b')
      mockAuthStateCallback?.('SIGNED_IN', {
        user: { id: 'user-b', email: 'b@example.test' },
        access_token: 'token-b',
        refresh_token: 'refresh-b',
      })
      mockAuthStateCallback?.('SIGNED_OUT', null)
    })
    await waitFor(() => expect(result.current.viewerKey).toBe('user:user-b'))
    await act(async () => tokenRefreshCoordinator.signOut())
  })

  it('commits anonymous state even when the Supabase signOut call throws', async () => {
    const { result } = renderHook(() => useAuthSession())
    await waitFor(() => expect(mockAuthStateCallback).toBeDefined())
    act(() => {
      const generation = tokenRefreshCoordinator.beginIdentityTransition('user-a')
      tokenRefreshCoordinator.completeIdentityTransition(generation, 'user-a')
      mockAuthStateCallback?.('SIGNED_IN', {
        user: { id: 'user-a', email: 'a@example.test' },
        access_token: 'token-a',
        refresh_token: 'refresh-a',
      })
    })
    await waitFor(() => expect(result.current.userId).toBe('user-a'))
    mockSignOut.mockRejectedValueOnce(new Error('network failure'))

    await act(async () => result.current.signOut())

    expect(result.current.authChecked).toBe(true)
    expect(result.current.isLoggedIn).toBe(false)
    expect(result.current.userId).toBeNull()
    expect(result.current.viewerKey).toBe('anon')
  })
})
