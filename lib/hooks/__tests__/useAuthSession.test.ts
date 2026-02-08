/**
 * useAuthSession hook tests
 * Tests categorizeError utility (pure function, no complex mocks needed)
 */

// Mock supabase before imports
jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: jest.fn().mockReturnValue({ data: { subscription: { unsubscribe: jest.fn() } } }),
      refreshSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signOut: jest.fn().mockResolvedValue({}),
    },
  },
}))

import { renderHook, act } from '@testing-library/react'
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
        message: '请先登录',
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
})
