import { act, renderHook, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockRouterPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, refresh: jest.fn() }),
}))

jest.mock('@/lib/supabase/client', () => {
  const publicMaybeSingle = jest.fn()
  const sensitiveMaybeSingle = jest.fn()
  const profileSaveMaybeSingle = jest.fn()
  const publicQuery: Record<string, jest.Mock> = {}
  publicQuery.select = jest.fn(() => publicQuery)
  publicQuery.eq = jest.fn(() => publicQuery)
  publicQuery.update = jest.fn(() => publicQuery)
  publicQuery.maybeSingle = publicMaybeSingle
  const rpc = jest.fn((name: string) => ({
    maybeSingle:
      name === 'update_own_profile_settings' ? profileSaveMaybeSingle : sensitiveMaybeSingle,
  }))
  return {
    supabase: {
      from: jest.fn(() => publicQuery),
      rpc,
      auth: {
        resetPasswordForEmail: jest.fn(),
        signOut: jest.fn(),
      },
    },
    __settingsMocks: {
      publicMaybeSingle,
      sensitiveMaybeSingle,
      profileSaveMaybeSingle,
      publicQuery,
      rpc,
    },
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
jest.mock('@/lib/auth/account-recovery-token', () => {
  const actual = jest.requireActual('@/lib/auth/account-recovery-token')
  const replaceDocument = jest.fn(() => true)
  return {
    ...actual,
    replaceDocumentForAccountRecovery: replaceDocument,
    __settingsMocks: { replaceDocument },
  }
})

import { useSettingsHandlers } from '../hooks/useSettingsHandlers'
import {
  ACCOUNT_RECOVERY_SESSION_TOKEN_KEY,
  ACCOUNT_RECOVERY_TOKEN_KEY,
  clearAccountRecoveryToken,
} from '@/lib/auth/account-recovery-token'

const {
  publicMaybeSingle: mockPublicMaybeSingle,
  sensitiveMaybeSingle: mockSensitiveMaybeSingle,
  profileSaveMaybeSingle: mockProfileSaveMaybeSingle,
  publicQuery: mockPublicQuery,
  rpc: mockRpc,
} = jest.requireMock('@/lib/supabase/client').__settingsMocks as {
  publicMaybeSingle: jest.Mock
  sensitiveMaybeSingle: jest.Mock
  profileSaveMaybeSingle: jest.Mock
  publicQuery: Record<string, jest.Mock>
  rpc: jest.Mock
}
const { authedFetch: mockAuthedFetch } = jest.requireMock('@/lib/api/client').__settingsMocks as {
  authedFetch: jest.Mock
}
const {
  forceRefresh: mockForceRefresh,
  reauthenticateWithPassword: mockReauthenticateWithPassword,
  updateUser: mockUpdateUser,
} = jest.requireMock('@/lib/auth/token-refresh').tokenRefreshCoordinator as {
  forceRefresh: jest.Mock
  reauthenticateWithPassword: jest.Mock
  updateUser: jest.Mock
}
const { replaceDocument: mockReplaceDocument } = jest.requireMock(
  '@/lib/auth/account-recovery-token'
).__settingsMocks as {
  replaceDocument: jest.Mock
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function jwt(userId: string, amr?: unknown): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId, ...(amr === undefined ? {} : { amr }) })}.signature`
}

function authFor(userId: string, sessionGeneration: number): AuthSessionReturn {
  return {
    user: {
      id: userId,
      email: `${userId}@example.com`,
      app_metadata: { provider: 'google', providers: ['google'] },
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

function sensitiveProfile(settingsVersion = 0) {
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
      settings_version: settingsVersion,
    },
    error: null,
  }
}

describe('useSettingsHandlers viewer ownership', () => {
  const showToast = jest.fn()
  const showConfirm = jest.fn()
  const t = (key: string) => key
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    clearAccountRecoveryToken()
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.history.replaceState(null, '', '/settings')
    mockPublicMaybeSingle.mockReset()
    mockSensitiveMaybeSingle.mockReset()
    mockProfileSaveMaybeSingle.mockReset()
    mockProfileSaveMaybeSingle.mockResolvedValue({
      data: { profile_id: 'user-a', settings_version: 1 },
      error: null,
    })
    __resetViewerScopeForTests()
    mockAuthedFetch.mockResolvedValue({ ok: true, status: 200, data: { success: true } })
    mockForceRefresh.mockResolvedValue(jwt('user-a'))
    mockReauthenticateWithPassword.mockResolvedValue({ error: null })
    mockUpdateUser.mockResolvedValue({ error: null })
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
  })

  afterAll(() => {
    global.fetch = originalFetch
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

  it('exposes a retryable failure instead of writable defaults when the sensitive row is missing', async () => {
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce(sensitiveProfile())
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
    expect(hook.result.current.profileLoadFailed).toBe(true)
    expect(hook.result.current.initialValuesRef.current).toBeNull()
    expect(hook.result.current.handle).toBe('')

    act(() => hook.result.current.handleEmailDigestChange('weekly'))
    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(hook.result.current.emailDigest).toBe('none')
    expect(showToast).toHaveBeenCalledWith('saveFailed', 'error')

    await act(async () => {
      await hook.result.current.loadProfile()
    })

    expect(hook.result.current.profileLoadFailed).toBe(false)
    expect(hook.result.current.handle).toBe('alpha')
    expect(hook.result.current.initialValuesRef.current?.handle).toBe('alpha')
  })

  it('does not present a failed passkey read as an empty credential list', async () => {
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    mockAuthedFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      data: { error: 'unavailable' },
    })
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    const hook = renderHook(() => useSettingsHandlers({ auth, showToast, showConfirm, t }))

    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    await act(async () => {
      await hook.result.current.loadPasskeys()
    })

    expect(hook.result.current.passkeys).toEqual([])
    expect(hook.result.current.passkeysLoadFailed).toBe(true)

    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        passkeys: [
          {
            id: 'credential-1',
            deviceName: 'Laptop',
            createdAt: '2026-07-29T00:00:00.000Z',
            lastUsedAt: null,
            transports: ['internal'],
          },
        ],
      },
    })
    await act(async () => {
      await hook.result.current.loadPasskeys()
    })

    expect(hook.result.current.passkeysLoadFailed).toBe(false)
    expect(hook.result.current.passkeys).toHaveLength(1)
  })

  it('keeps a passkey visible without an exact removal acknowledgement and single-flights clicks', async () => {
    const credentialId = '00000000-0000-4000-8000-000000000001'
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        passkeys: [
          {
            id: credentialId,
            deviceName: 'Laptop',
            createdAt: '2026-07-29T00:00:00.000Z',
            lastUsedAt: null,
            transports: ['internal'],
          },
        ],
      },
    })
    showConfirm.mockResolvedValue(true)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }) as unknown as typeof fetch
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    const hook = renderHook(() => useSettingsHandlers({ auth, showToast, showConfirm, t }))

    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    await act(async () => {
      await hook.result.current.loadPasskeys()
    })
    expect(hook.result.current.passkeys).toHaveLength(1)

    await act(async () => {
      await Promise.all([
        hook.result.current.handleRemovePasskey(credentialId),
        hook.result.current.handleRemovePasskey(credentialId),
      ])
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(hook.result.current.passkeys).toHaveLength(1)
    expect(showToast).toHaveBeenCalledWith('operationFailed', 'error')
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ removed: true }),
    })
    await act(async () => {
      await hook.result.current.handleRemovePasskey(credentialId)
    })

    expect(hook.result.current.passkeys).toEqual([])
    expect(showToast).toHaveBeenCalledWith('passkeyRemoved', 'success')
  })

  it('does not present a failed block-list read as no blocked users', async () => {
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    const hook = renderHook(() => useSettingsHandlers({ auth, showToast, showConfirm, t }))

    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    mockPublicQuery.eq.mockImplementationOnce(async () => ({
      data: null,
      error: { message: 'database unavailable' },
    }))
    await act(async () => {
      await hook.result.current.loadBlockedUsers()
    })

    expect(hook.result.current.blockedUsers).toEqual([])
    expect(hook.result.current.blockedUsersLoadFailed).toBe(true)

    mockPublicQuery.eq.mockImplementationOnce(async () => ({ data: [], error: null }))
    await act(async () => {
      await hook.result.current.loadBlockedUsers()
    })

    expect(hook.result.current.blockedUsersLoadFailed).toBe(false)
    expect(hook.result.current.blockedUsers).toEqual([])
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

  it('checks availability for a valid one-character changed handle', async () => {
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    mockAuthedFetch.mockResolvedValue({ ok: true, status: 200, data: { available: true } })
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

    act(() => hook.result.current.setHandle('界'))

    await waitFor(
      () =>
        expect(mockAuthedFetch).toHaveBeenCalledWith(
          '/api/profile/handle-availability',
          'POST',
          expect.any(String),
          { handle: '界' },
          15_000,
          expect.objectContaining({ expectedUserId: 'user-a' })
        ),
      { timeout: 1_500 }
    )
    await waitFor(() => expect(hook.result.current.handleAvailable).toBe(true))
  })

  it('blocks an empty handle before any profile write', async () => {
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
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

    act(() => hook.result.current.setHandle(''))
    await act(async () => {
      await hook.result.current.handleSaveProfile()
    })

    expect(mockPublicMaybeSingle).toHaveBeenCalledTimes(1)
    expect(mockRpc).not.toHaveBeenCalledWith('update_own_profile_settings', expect.anything())
    expect(showToast).toHaveBeenCalledWith('validationHandleMinLength', 'error')
  })

  it('preserves an exactly unchanged legacy dotted handle while saving other fields', async () => {
    mockPublicMaybeSingle
      .mockResolvedValueOnce(publicProfile('legacy.user'))
      .mockResolvedValueOnce({ data: { avatar_url: null, cover_url: null }, error: null })
      .mockResolvedValueOnce({ data: { id: 'user-a' }, error: null })
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    const scope = synchronizeViewerScope(true, 'user-a')
    const hook = renderHook(() =>
      useSettingsHandlers({
        auth: authFor('user-a', scope.sessionGeneration),
        showToast,
        showConfirm,
        t,
      })
    )
    await waitFor(() => expect(hook.result.current.handle).toBe('legacy.user'))

    act(() => hook.result.current.setBio('updated bio'))
    await act(async () => {
      await hook.result.current.handleSaveProfile()
    })

    expect(mockRpc).toHaveBeenCalledWith(
      'update_own_profile_settings',
      expect.objectContaining({ p_expected_version: 0, p_handle: null, p_bio: 'updated bio' })
    )
    expect(showToast).toHaveBeenCalledWith('settingsSaved', 'success')
  })

  it('keeps a removed cover as an unsaved change until the null URL is persisted', async () => {
    const profileWithCover = {
      ...publicProfile('alpha'),
      data: {
        ...publicProfile('alpha').data,
        cover_url: 'https://cdn.example.com/cover.jpg',
      },
    }
    mockPublicMaybeSingle
      .mockResolvedValueOnce(profileWithCover)
      .mockResolvedValueOnce({
        data: { avatar_url: null, cover_url: profileWithCover.data.cover_url },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: 'user-a' }, error: null })
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    const scope = synchronizeViewerScope(true, 'user-a')
    const hook = renderHook(() =>
      useSettingsHandlers({
        auth: authFor('user-a', scope.sessionGeneration),
        showToast,
        showConfirm,
        t,
      })
    )
    await waitFor(() => expect(hook.result.current.coverUrl).toBe(profileWithCover.data.cover_url))
    expect(hook.result.current.hasUnsavedChanges()).toBe(false)

    act(() => hook.result.current.handleRemoveCover())

    expect(hook.result.current.coverUrl).toBeNull()
    expect(hook.result.current.hasUnsavedChanges()).toBe(true)

    await act(async () => {
      await hook.result.current.handleSaveProfile()
    })

    expect(mockRpc).toHaveBeenCalledWith(
      'update_own_profile_settings',
      expect.objectContaining({ p_cover_url: null, p_expected_version: 0 })
    )
    expect(hook.result.current.hasUnsavedChanges()).toBe(false)
  })

  it('rolls back canonical image URLs when uploads succeed but the profile write fails', async () => {
    const oldAvatar = 'https://cdn.example.com/old-avatar.jpg'
    const oldCover = 'https://cdn.example.com/old-cover.jpg'
    const newAvatar = 'https://cdn.example.com/new-avatar.jpg'
    const newCover = 'https://cdn.example.com/new-cover.png'
    mockPublicMaybeSingle
      .mockResolvedValueOnce({
        ...publicProfile('alpha'),
        data: { ...publicProfile('alpha').data, avatar_url: oldAvatar, cover_url: oldCover },
      })
      .mockResolvedValueOnce({
        data: { avatar_url: oldAvatar, cover_url: oldCover },
        error: null,
      })
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    mockProfileSaveMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: 'XX001', message: 'profile write failed' },
    })
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: newAvatar }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: newCover }),
      }) as unknown as typeof fetch

    const scope = synchronizeViewerScope(true, 'user-a')
    const hook = renderHook(() =>
      useSettingsHandlers({
        auth: authFor('user-a', scope.sessionGeneration),
        showToast,
        showConfirm,
        t,
      })
    )
    await waitFor(() => expect(hook.result.current.previewUrl).toBe(oldAvatar))

    act(() => {
      hook.result.current.setAvatarFile(new File(['avatar'], 'avatar.jpg', { type: 'image/jpeg' }))
      hook.result.current.setCoverFile(new File(['cover'], 'cover.png', { type: 'image/png' }))
    })
    await act(async () => {
      await hook.result.current.handleSaveProfile()
    })

    expect(mockRpc).toHaveBeenCalledWith(
      'update_own_profile_settings',
      expect.objectContaining({ p_avatar_url: newAvatar, p_cover_url: newCover })
    )
    expect(hook.result.current.previewUrl).toBe(oldAvatar)
    expect(hook.result.current.coverPreviewUrl).toBe(oldCover)
    expect(hook.result.current.coverUrl).toBe(oldCover)
    expect(hook.result.current.hasUnsavedChanges()).toBe(false)
    expect(showToast).toHaveBeenCalledWith(
      'saveFailedWithMsg'.replace('{msg}', 'profile write failed'),
      'error'
    )
  })

  it('writes a changed canonical CJK handle as a non-null string', async () => {
    mockPublicMaybeSingle
      .mockResolvedValueOnce(publicProfile('alpha'))
      .mockResolvedValueOnce({ data: { avatar_url: null, cover_url: null }, error: null })
      .mockResolvedValueOnce({ data: { id: 'user-a' }, error: null })
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    const scope = synchronizeViewerScope(true, 'user-a')
    const hook = renderHook(() =>
      useSettingsHandlers({
        auth: authFor('user-a', scope.sessionGeneration),
        showToast,
        showConfirm,
        t,
      })
    )
    await waitFor(() => expect(hook.result.current.handle).toBe('alpha'))

    act(() => hook.result.current.setHandle('交易员甲'))
    await act(async () => {
      await hook.result.current.handleSaveProfile()
    })

    expect(mockRpc).toHaveBeenCalledWith(
      'update_own_profile_settings',
      expect.objectContaining({ p_handle: '交易员甲', p_expected_version: 0 })
    )
  })

  it('maps a database handle check violation to the handle validation error', async () => {
    mockPublicMaybeSingle
      .mockResolvedValueOnce(publicProfile('alpha'))
      .mockResolvedValueOnce({ data: { avatar_url: null, cover_url: null }, error: null })
    mockProfileSaveMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: '23514', message: 'check violation' },
    })
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    const scope = synchronizeViewerScope(true, 'user-a')
    const hook = renderHook(() =>
      useSettingsHandlers({
        auth: authFor('user-a', scope.sessionGeneration),
        showToast,
        showConfirm,
        t,
      })
    )
    await waitFor(() => expect(hook.result.current.handle).toBe('alpha'))

    act(() => hook.result.current.setHandle('bravo'))
    await act(async () => {
      await hook.result.current.handleSaveProfile()
    })

    expect(showToast).toHaveBeenCalledWith('validationHandleInvalidChars', 'error')
  })

  it('rejects a stale profile save without discarding the local edit', async () => {
    mockPublicMaybeSingle
      .mockResolvedValueOnce(publicProfile('alpha'))
      .mockResolvedValueOnce({ data: { avatar_url: null, cover_url: null }, error: null })
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile(7))
    mockProfileSaveMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: '40001', message: 'profile settings changed since they were loaded' },
    })
    const scope = synchronizeViewerScope(true, 'user-a')
    const hook = renderHook(() =>
      useSettingsHandlers({
        auth: authFor('user-a', scope.sessionGeneration),
        showToast,
        showConfirm,
        t,
      })
    )
    await waitFor(() => expect(hook.result.current.handle).toBe('alpha'))

    act(() => hook.result.current.setBio('local unsaved edit'))
    await act(async () => {
      await hook.result.current.handleSaveProfile()
    })

    expect(mockRpc).toHaveBeenCalledWith(
      'update_own_profile_settings',
      expect.objectContaining({ p_expected_version: 7, p_bio: 'local unsaved edit' })
    )
    expect(showToast).toHaveBeenCalledWith('profileSaveConflict', 'error')
    expect(hook.result.current.bio).toBe('local unsaved edit')
    expect(hook.result.current.hasUnsavedChanges()).toBe(true)
  })

  it('uses each committed revision as the next save precondition', async () => {
    mockPublicMaybeSingle
      .mockResolvedValueOnce(publicProfile('alpha'))
      .mockResolvedValueOnce({ data: { avatar_url: null, cover_url: null }, error: null })
      .mockResolvedValueOnce({ data: { avatar_url: null, cover_url: null }, error: null })
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    mockProfileSaveMaybeSingle
      .mockResolvedValueOnce({
        data: { profile_id: 'user-a', settings_version: 1 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { profile_id: 'user-a', settings_version: 2 },
        error: null,
      })
    const scope = synchronizeViewerScope(true, 'user-a')
    const hook = renderHook(() =>
      useSettingsHandlers({
        auth: authFor('user-a', scope.sessionGeneration),
        showToast,
        showConfirm,
        t,
      })
    )
    await waitFor(() => expect(hook.result.current.handle).toBe('alpha'))

    act(() => hook.result.current.setBio('first edit'))
    await act(async () => {
      await hook.result.current.handleSaveProfile()
    })
    act(() => hook.result.current.setBio('second edit'))
    await act(async () => {
      await hook.result.current.handleSaveProfile()
    })

    const saveCalls = mockRpc.mock.calls.filter((call) => call[0] === 'update_own_profile_settings')
    expect(saveCalls).toHaveLength(2)
    expect(saveCalls[0][1]).toEqual(expect.objectContaining({ p_expected_version: 0 }))
    expect(saveCalls[1][1]).toEqual(expect.objectContaining({ p_expected_version: 1 }))
  })

  it('revokes real other sessions through the authenticated server after a password change', async () => {
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true, revokedOthers: true },
    })
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    const hook = renderHook(() => useSettingsHandlers({ auth, showToast, showConfirm, t }))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))

    act(() => {
      hook.result.current.setCurrentPassword('old-password')
      hook.result.current.setNewPassword('new-password')
      hook.result.current.setConfirmNewPassword('new-password')
    })
    await act(async () => {
      await hook.result.current.handleChangePassword()
    })

    expect(mockReauthenticateWithPassword).toHaveBeenCalledWith(
      { email: 'user-a@example.com', password: 'old-password' },
      { expectedUserId: 'user-a', sessionGeneration: scope.sessionGeneration }
    )
    expect(mockUpdateUser).toHaveBeenCalledWith(
      { password: 'new-password' },
      { expectedUserId: 'user-a', sessionGeneration: scope.sessionGeneration }
    )
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/settings/sessions',
      'DELETE',
      jwt('user-a'),
      { all: true },
      15_000,
      { expectedUserId: 'user-a', expectedSessionGeneration: scope.sessionGeneration }
    )
    expect(showToast).toHaveBeenCalledWith('passwordChanged', 'success')
  })

  it('offers one truthful user-triggered operation for revoking every other session', async () => {
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true, revokedOthers: true },
    })
    showConfirm.mockResolvedValue(true)
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    const hook = renderHook(() => useSettingsHandlers({ auth, showToast, showConfirm, t }))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))

    await act(async () => {
      await hook.result.current.handleRevokeOtherSessions()
    })

    expect(showConfirm).toHaveBeenCalledWith('logoutAllDevices', 'logoutAllDevicesConfirm')
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/settings/sessions',
      'DELETE',
      jwt('user-a'),
      { all: true },
      15_000,
      { expectedUserId: 'user-a', expectedSessionGeneration: scope.sessionGeneration }
    )
    expect(showToast).toHaveBeenCalledWith('logoutAllSuccess', 'success')
    expect(hook.result.current.revokingOtherSessions).toBe(false)
  })

  it('keeps an already-running Replay clean when localStorage and local sign-out fail', async () => {
    const recoveryToken = 'A'.repeat(43)
    const replayContext = { urls: [] as string[] }
    const navigationPush = { op: 'navigation.push', name: '' }
    const rrwebMeta = { type: 4, data: { href: '' } }
    mockRouterPush.mockImplementation((target: string) => {
      navigationPush.name = target
      replayContext.urls.push(target)
      window.history.pushState(null, '', target)
      rrwebMeta.data.href = window.location.href
    })
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, user_id: 'user-a', recovery_token: recoveryToken }),
    }) as unknown as typeof fetch

    const originalSetItem = Storage.prototype.setItem
    const storageSet = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (this === window.localStorage) {
        throw new DOMException('localStorage blocked', 'SecurityError')
      }
      return originalSetItem.call(this, key, value)
    })
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    const signOut = auth.signOut as jest.Mock
    signOut.mockRejectedValue(new Error('local sign-out failed'))
    const hook = renderHook(() => useSettingsHandlers({ auth, showToast, showConfirm, t }))

    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => {
      hook.result.current.setShowDeleteAccountModal(true)
      hook.result.current.setDeleteConfirm('DELETE')
    })
    await waitFor(() => expect(hook.result.current.deleteHasPassword).toBe(false))

    await act(async () => {
      await hook.result.current.handleDeleteAccount()
    })

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(mockRouterPush).toHaveBeenCalledWith('/login?account_deleted=1')
    expect(mockReplaceDocument).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBe(recoveryToken)
    expect(JSON.stringify({ replayContext, navigationPush, rrwebMeta })).not.toContain(
      recoveryToken
    )
    expect(hook.result.current.deleteError).toBeNull()
    expect(showToast).toHaveBeenCalledWith('accountMarkedDeleted', 'success')
    storageSet.mockRestore()
  })

  it('offers typed deletion to an email-OTP account that has no password', async () => {
    const recoveryToken = 'A'.repeat(43)
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, user_id: 'user-a', recovery_token: recoveryToken }),
    }) as unknown as typeof fetch

    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    auth.accessToken = jwt('user-a', [{ method: 'otp', timestamp: 123 }])
    auth.user!.app_metadata = { provider: 'email', providers: ['email'] }
    auth.user!.identities = [{ provider: 'email' }] as typeof auth.user.identities
    const hook = renderHook(() => useSettingsHandlers({ auth, showToast, showConfirm, t }))

    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => {
      hook.result.current.setShowDeleteAccountModal(true)
      hook.result.current.setDeleteConfirm('DELETE')
    })
    await waitFor(() => expect(hook.result.current.deleteHasPassword).toBe(false))

    await act(async () => {
      await hook.result.current.handleDeleteAccount()
    })

    const request = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit
    const body = JSON.parse(String(request.body)) as Record<string, unknown>
    expect(body.confirm).toBe('DELETE')
    expect(body).not.toHaveProperty('password')
  })

  it('uses full-document replacement, never client history, when all storage is blocked', async () => {
    const recoveryToken = 'A'.repeat(43)
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, user_id: 'user-a', recovery_token: recoveryToken }),
    }) as unknown as typeof fetch

    const storageSet = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    const hook = renderHook(() => useSettingsHandlers({ auth, showToast, showConfirm, t }))

    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => {
      hook.result.current.setShowDeleteAccountModal(true)
      hook.result.current.setDeleteConfirm('DELETE')
    })
    await waitFor(() => expect(hook.result.current.deleteHasPassword).toBe(false))

    await act(async () => {
      await hook.result.current.handleDeleteAccount()
    })

    expect(mockRouterPush).not.toHaveBeenCalled()
    expect(mockReplaceDocument).toHaveBeenCalledTimes(1)
    expect(mockReplaceDocument).toHaveBeenCalledWith(recoveryToken)
    expect(hook.result.current.deleteError).toBeNull()
    expect(showToast).toHaveBeenCalledWith('accountMarkedDeleted', 'success')
    storageSet.mockRestore()
  })

  it('stages the exact credential before dispatch and single-flights rapid deletion clicks', async () => {
    const deletionResponse = deferred<Response>()
    mockPublicMaybeSingle.mockResolvedValue(publicProfile('alpha'))
    mockSensitiveMaybeSingle.mockResolvedValue(sensitiveProfile())
    global.fetch = jest.fn().mockReturnValue(deletionResponse.promise) as unknown as typeof fetch
    const scope = synchronizeViewerScope(true, 'user-a')
    const auth = authFor('user-a', scope.sessionGeneration)
    const hook = renderHook(() => useSettingsHandlers({ auth, showToast, showConfirm, t }))

    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => {
      hook.result.current.setShowDeleteAccountModal(true)
      hook.result.current.setDeleteConfirm('DELETE')
    })
    await waitFor(() => expect(hook.result.current.deleteHasPassword).toBe(false))

    let first!: Promise<void>
    let duplicate!: Promise<void>
    act(() => {
      first = hook.result.current.handleDeleteAccount()
      duplicate = hook.result.current.handleDeleteAccount()
    })

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    const request = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit
    const body = JSON.parse(String(request.body)) as { recovery_token: string }
    expect(body.recovery_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBe(body.recovery_token)
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBe(
      body.recovery_token
    )

    await act(async () => {
      deletionResponse.reject(new TypeError('response lost after commit'))
      await Promise.all([first, duplicate])
    })

    expect(window.localStorage.getItem(ACCOUNT_RECOVERY_TOKEN_KEY)).toBe(body.recovery_token)
    expect(window.sessionStorage.getItem(ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)).toBe(
      body.recovery_token
    )
    expect(hook.result.current.deleteError).toBe('networkErrorRetry')
  })

  it('lets B start after the viewer reset without allowing late A to clear B single-flight', async () => {
    const deletionA = deferred<Response>()
    const deletionB = deferred<Response>()
    mockPublicMaybeSingle
      .mockResolvedValueOnce(publicProfile('alpha'))
      .mockResolvedValueOnce(publicProfile('bravo'))
    mockSensitiveMaybeSingle
      .mockResolvedValueOnce(sensitiveProfile())
      .mockResolvedValueOnce(sensitiveProfile())
    mockForceRefresh.mockImplementation(async ({ expectedUserId }: { expectedUserId: string }) =>
      jwt(expectedUserId)
    )
    global.fetch = jest
      .fn()
      .mockReturnValueOnce(deletionA.promise)
      .mockReturnValueOnce(deletionB.promise) as unknown as typeof fetch

    const scopeA = synchronizeViewerScope(true, 'user-a')
    const hook = renderHook(
      ({ auth }) => useSettingsHandlers({ auth, showToast, showConfirm, t }),
      { initialProps: { auth: authFor('user-a', scopeA.sessionGeneration) } }
    )
    await waitFor(() => expect(hook.result.current.handle).toBe('alpha'))
    act(() => {
      hook.result.current.setShowDeleteAccountModal(true)
      hook.result.current.setDeleteConfirm('DELETE')
    })
    await waitFor(() => expect(hook.result.current.deleteHasPassword).toBe(false))

    let requestA!: Promise<void>
    act(() => {
      requestA = hook.result.current.handleDeleteAccount()
    })
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    hook.rerender({ auth: authFor('user-b', scopeB.sessionGeneration) })
    await waitFor(() => expect(hook.result.current.handle).toBe('bravo'))
    act(() => {
      hook.result.current.setShowDeleteAccountModal(true)
      hook.result.current.setDeleteConfirm('DELETE')
    })
    await waitFor(() => expect(hook.result.current.deleteHasPassword).toBe(false))

    let requestB!: Promise<void>
    act(() => {
      requestB = hook.result.current.handleDeleteAccount()
      void hook.result.current.handleDeleteAccount()
    })
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))

    await act(async () => {
      deletionA.resolve(new Response(null, { status: 200 }))
      await requestA
    })

    act(() => {
      void hook.result.current.handleDeleteAccount()
    })
    expect(global.fetch).toHaveBeenCalledTimes(2)

    await act(async () => {
      deletionB.reject(new TypeError('B response pending outcome'))
      await requestB
    })
  })
})
