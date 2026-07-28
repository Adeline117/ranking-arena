import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockUseAuthSession = jest.fn()
const mockMaybeSingle = jest.fn()
const mockEq = jest.fn(() => ({ maybeSingle: (...args: unknown[]) => mockMaybeSingle(...args) }))
const mockSelect = jest.fn(() => ({ eq: (...args: unknown[]) => mockEq(...args) }))
const mockFrom = jest.fn(() => ({ select: (...args: unknown[]) => mockSelect(...args) }))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

import { useViewerProfileHandle } from '@/lib/hooks/useViewerProfileHandle'

function jwt(userId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function authFor(userId: string, sessionGeneration: number, email = `${userId}@example.com`) {
  return {
    accessToken: jwt(userId),
    authChecked: true,
    email,
    isLoggedIn: true,
    loading: false,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}` as const,
  }
}

function pendingAuth(sessionGeneration: number) {
  return {
    accessToken: null,
    authChecked: false,
    email: null,
    isLoggedIn: false,
    loading: true,
    sessionGeneration,
    userId: null,
    viewerKey: 'pending' as const,
  }
}

function profile(handle: string) {
  return { data: { handle }, error: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

describe('useViewerProfileHandle viewer ownership', () => {
  let currentAuth: ReturnType<typeof authFor> | ReturnType<typeof pendingAuth>

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-a')
    currentAuth = authFor('user-a', scope.sessionGeneration)
    mockUseAuthSession.mockImplementation(() => currentAuth)
  })

  it('fails empty during A→pending→B and discards A profile completion', async () => {
    const profileA = deferred<ReturnType<typeof profile>>()
    const profileB = deferred<ReturnType<typeof profile>>()
    mockMaybeSingle.mockReturnValueOnce(profileA.promise).mockReturnValueOnce(profileB.promise)

    const view = renderHook(() => useViewerProfileHandle())
    expect(view.result.current).toBe('user-a')
    await waitFor(() => expect(mockMaybeSingle).toHaveBeenCalledTimes(1))

    const transitionGeneration = beginViewerTransition('user-b')
    currentAuth = pendingAuth(transitionGeneration)
    view.rerender()
    expect(view.result.current).toBeNull()

    const scopeB = commitViewerTransition(transitionGeneration, 'user-b')
    expect(scopeB).not.toBeNull()
    currentAuth = authFor('user-b', scopeB!.sessionGeneration)
    view.rerender()

    expect(view.result.current).toBe('user-b')
    await waitFor(() => expect(mockMaybeSingle).toHaveBeenCalledTimes(2))

    await act(async () => profileA.resolve(profile('private-a-handle')))
    expect(view.result.current).toBe('user-b')

    await act(async () => profileB.resolve(profile('canonical-b-handle')))
    await waitFor(() => expect(view.result.current).toBe('canonical-b-handle'))
    expect(view.result.current).not.toContain('private-a')
  })

  it('isolates a new generation of the same user', async () => {
    const oldGenerationProfile = deferred<ReturnType<typeof profile>>()
    const newGenerationProfile = deferred<ReturnType<typeof profile>>()
    mockMaybeSingle
      .mockReturnValueOnce(oldGenerationProfile.promise)
      .mockReturnValueOnce(newGenerationProfile.promise)

    const view = renderHook(() => useViewerProfileHandle())
    await waitFor(() => expect(mockMaybeSingle).toHaveBeenCalledTimes(1))

    const transitionGeneration = beginViewerTransition('user-a')
    const nextScope = commitViewerTransition(transitionGeneration, 'user-a')
    expect(nextScope).not.toBeNull()
    currentAuth = authFor('user-a', nextScope!.sessionGeneration)
    view.rerender()

    expect(view.result.current).toBe('user-a')
    await waitFor(() => expect(mockMaybeSingle).toHaveBeenCalledTimes(2))

    await act(async () => oldGenerationProfile.resolve(profile('old-generation-handle')))
    expect(view.result.current).toBe('user-a')

    await act(async () => newGenerationProfile.resolve(profile('new-generation-handle')))
    await waitFor(() => expect(view.result.current).toBe('new-generation-handle'))
  })

  it('keeps the current viewer fallback after a profile error without leaking rejection', async () => {
    mockMaybeSingle.mockRejectedValueOnce(new Error('profile storage unavailable'))

    const view = renderHook(() => useViewerProfileHandle())

    expect(view.result.current).toBe('user-a')
    await waitFor(() => expect(mockMaybeSingle).toHaveBeenCalledTimes(1))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(view.result.current).toBe('user-a')
  })

  it('publishes neither a handle nor a profile query for unresolved or anonymous auth', () => {
    const pendingScope = beginViewerTransition()
    currentAuth = pendingAuth(pendingScope)
    const view = renderHook(() => useViewerProfileHandle())
    expect(view.result.current).toBeNull()
    expect(mockMaybeSingle).not.toHaveBeenCalled()

    const anonScope = commitViewerTransition(pendingScope, null)
    expect(anonScope).not.toBeNull()
    currentAuth = {
      ...pendingAuth(anonScope!.sessionGeneration),
      authChecked: true,
      loading: false,
      viewerKey: 'anon',
    }
    view.rerender()
    expect(view.result.current).toBeNull()
    expect(mockMaybeSingle).not.toHaveBeenCalled()
  })

  it('fails empty when the bearer subject does not match the canonical auth user', () => {
    currentAuth = {
      ...currentAuth,
      accessToken: jwt('different-user'),
    }

    const view = renderHook(() => useViewerProfileHandle())

    expect(view.result.current).toBeNull()
    expect(mockMaybeSingle).not.toHaveBeenCalled()
  })

  it('binds both navigation surfaces to the shared scoped hook and removes the global cache', () => {
    const root = process.cwd()
    const mobile = readFileSync(join(root, 'app/components/layout/MobileBottomNav.tsx'), 'utf8')
    const desktop = readFileSync(join(root, 'app/components/layout/DesktopSidebar.tsx'), 'utf8')

    for (const source of [mobile, desktop]) {
      expect(source).toContain('useViewerProfileHandle()')
      expect(source).not.toContain('.auth.getSession()')
      expect(source).not.toContain('.auth.onAuthStateChange(')
    }
    expect(mobile).not.toContain('arena:user_handle')
    expect(mobile).not.toContain('sessionStorage')
  })
})
