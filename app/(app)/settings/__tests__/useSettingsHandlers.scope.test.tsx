import { act, renderHook, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}))

jest.mock('@/lib/supabase/client', () => {
  const publicMaybeSingle = jest.fn()
  const sensitiveMaybeSingle = jest.fn()
  const publicQuery: Record<string, jest.Mock> = {}
  publicQuery.select = jest.fn(() => publicQuery)
  publicQuery.eq = jest.fn(() => publicQuery)
  publicQuery.update = jest.fn(() => publicQuery)
  publicQuery.maybeSingle = publicMaybeSingle
  return {
    supabase: {
      from: jest.fn(() => publicQuery),
      rpc: jest.fn(() => ({ maybeSingle: sensitiveMaybeSingle })),
      auth: {
        resetPasswordForEmail: jest.fn(),
        signOut: jest.fn(),
      },
    },
    __settingsMocks: { publicMaybeSingle, sensitiveMaybeSingle },
  }
})

jest.mock('@/lib/api/client', () => {
  const authedFetch = jest.fn()
  return { authedFetch, getCsrfHeaders: () => ({}), __settingsMocks: { authedFetch } }
})

jest.mock('@/lib/utils/haptics', () => ({ isHapticsEnabled: () => true }))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
jest.mock('@/lib/utils/logger', () => ({
  uiLogger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    forceRefresh: jest.fn(),
    reauthenticateWithPassword: jest.fn(),
    updateUser: jest.fn(),
  },
}))

import { useSettingsHandlers } from '../hooks/useSettingsHandlers'

const { publicMaybeSingle: mockPublicMaybeSingle, sensitiveMaybeSingle: mockSensitiveMaybeSingle } =
  jest.requireMock('@/lib/supabase/client').__settingsMocks as {
    publicMaybeSingle: jest.Mock
    sensitiveMaybeSingle: jest.Mock
  }
const { authedFetch: mockAuthedFetch } = jest.requireMock('@/lib/api/client').__settingsMocks as {
  authedFetch: jest.Mock
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function jwt(userId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function authFor(userId: string, sessionGeneration: number): AuthSessionReturn {
  return {
    user: {
      id: userId,
      email: `${userId}@example.com`,
      identities: [],
    },
    userId,
    email: `${userId}@example.com`,
    accessToken: jwt(userId),
    isLoggedIn: true,
    loading: false,
    authChecked: true,
    viewerKey: `user:${userId}`,
    sessionGeneration,
    getToken: jest.fn(),
    getAuthHeaders: jest.fn(),
    getAuthHeadersAsync: jest.fn(),
    requireAuth: jest.fn(),
    refreshSession: jest.fn(),
    categorizeError: jest.fn(),
    signOut: jest.fn(),
  } as unknown as AuthSessionReturn
}

function publicProfile(handle: string) {
  return {
    data: {
      handle,
      bio: `${handle} bio`,
      avatar_url: null,
      cover_url: null,
      show_followers: true,
      show_following: true,
      dm_permission: 'all',
      show_pro_badge: true,
    },
    error: null,
  }
}

function sensitiveProfile() {
  return {
    data: {
      notify_follow: true,
      notify_like: true,
      notify_comment: true,
      notify_mention: true,
      notify_message: true,
      notify_trader_events: true,
      totp_enabled: false,
      email_digest: 'none',
    },
    error: null,
  }
}

describe('useSettingsHandlers viewer ownership', () => {
  const showToast = jest.fn()
  const showConfirm = jest.fn()
  const t = (key: string) => key

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    mockAuthedFetch.mockResolvedValue({ ok: true, status: 200, data: { success: true } })
  })

  it('never lets a late A profile completion overwrite B', async () => {
    const publicA = deferred<ReturnType<typeof publicProfile>>()
    const sensitiveA = deferred<ReturnType<typeof sensitiveProfile>>()
    const publicB = deferred<ReturnType<typeof publicProfile>>()
    const sensitiveB = deferred<ReturnType<typeof sensitiveProfile>>()
    mockPublicMaybeSingle.mockReturnValueOnce(publicA.promise).mockReturnValueOnce(publicB.promise)
    mockSensitiveMaybeSingle
      .mockReturnValueOnce(sensitiveA.promise)
      .mockReturnValueOnce(sensitiveB.promise)

    const scopeA = synchronizeViewerScope(true, 'user-a')
    const hook = renderHook(
      ({ auth }) => useSettingsHandlers({ auth, showToast, showConfirm, t }),
      { initialProps: { auth: authFor('user-a', scopeA.sessionGeneration) } }
    )
    await waitFor(() => expect(mockPublicMaybeSingle).toHaveBeenCalledTimes(1))

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    hook.rerender({ auth: authFor('user-b', scopeB.sessionGeneration) })
    await waitFor(() => expect(mockPublicMaybeSingle).toHaveBeenCalledTimes(2))

    await act(async () => {
      publicB.resolve(publicProfile('bravo'))
      sensitiveB.resolve(sensitiveProfile())
    })
    await waitFor(() => expect(hook.result.current.handle).toBe('bravo'))

    await act(async () => {
      publicA.resolve(publicProfile('alpha'))
      sensitiveA.resolve(sensitiveProfile())
    })
    expect(hook.result.current.handle).toBe('bravo')
    expect(hook.result.current.initialValuesRef.current?.handle).toBe('bravo')
  })

  it('keeps sensitive defaults non-writable when the sensitive row is missing', async () => {
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue({ data: null, error: null })
    const scope = synchronizeViewerScope(true, 'user-a')
    const hook = renderHook(() =>
      useSettingsHandlers({
        auth: authFor('user-a', scope.sessionGeneration),
        showToast,
        showConfirm,
        t,
      })
    )

    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.initialValuesRef.current).toBeNull()
    expect(hook.result.current.handle).toBe('')

    act(() => hook.result.current.handleEmailDigestChange('weekly'))
    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(hook.result.current.emailDigest).toBe('none')
    expect(showToast).toHaveBeenCalledWith('saveFailed', 'error')
  })

  it('blocks A form actions while B ownership is still unresolved', async () => {
    const publicB = deferred<ReturnType<typeof publicProfile>>()
    const sensitiveB = deferred<ReturnType<typeof sensitiveProfile>>()
    mockPublicMaybeSingle
      .mockResolvedValueOnce(publicProfile('alpha'))
      .mockReturnValueOnce(publicB.promise)
    mockSensitiveMaybeSingle
      .mockResolvedValueOnce(sensitiveProfile())
      .mockReturnValueOnce(sensitiveB.promise)

    const scopeA = synchronizeViewerScope(true, 'user-a')
    const hook = renderHook(
      ({ auth }) => useSettingsHandlers({ auth, showToast, showConfirm, t }),
      { initialProps: { auth: authFor('user-a', scopeA.sessionGeneration) } }
    )
    await waitFor(() => expect(hook.result.current.handle).toBe('alpha'))

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    hook.rerender({ auth: authFor('user-b', scopeB.sessionGeneration) })
    await waitFor(() => expect(mockPublicMaybeSingle).toHaveBeenCalledTimes(2))

    expect(hook.result.current.loading).toBe(true)
    mockAuthedFetch.mockClear()
    const restoreToggle = jest.fn()
    await act(async () => {
      await hook.result.current.handleSaveProfile()
      hook.result.current.handleNotificationToggleSave('notify_follow', false, true, restoreToggle)
    })

    expect(mockPublicMaybeSingle).toHaveBeenCalledTimes(2)
    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(restoreToggle).toHaveBeenCalledWith(true)

    await act(async () => {
      publicB.resolve(publicProfile('bravo'))
      sensitiveB.resolve(sensitiveProfile())
    })
    await waitFor(() => expect(hook.result.current.handle).toBe('bravo'))
  })
})
