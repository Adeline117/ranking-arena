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

describe('useAuthSession', () => {
  it('starts in loading state', () => {
    const { result } = renderHook(() => useAuthSession())
    // Initially should not be logged in
    expect(result.current.isLoggedIn).toBe(false)
    expect(result.current.userId).toBeNull()
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

  it('commits anonymous state even when the Supabase signOut call throws', async () => {
    const { result } = renderHook(() => useAuthSession())
    await waitFor(() => expect(mockAuthStateCallback).toBeDefined())
    act(() => {
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
