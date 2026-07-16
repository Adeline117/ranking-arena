import { act, renderHook, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import type { ServerProfile } from '../../components/types'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

let mockAuth: AuthSessionReturn
const mockRouter = { replace: jest.fn() }
const mockShowToast = jest.fn()
const mockTranslate = (key: string) => key

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/u/profile',
}))

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, error: null, isLoading: false }),
}))

jest.mock('@/app/components/home/hooks/useSubscription', () => ({
  useSubscription: () => ({ isPro: false }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: mockTranslate }),
}))

jest.mock('@/lib/hooks/traderFetcher', () => ({ traderFetcher: jest.fn() }))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

jest.mock('@/lib/supabase/client', () => {
  const profileMaybeSingle = jest.fn()
  const blockExecute = jest.fn()
  const profileQuery: Record<string, jest.Mock> = {}
  profileQuery.select = jest.fn(() => profileQuery)
  profileQuery.eq = jest.fn(() => profileQuery)
  profileQuery.abortSignal = jest.fn(() => profileQuery)
  profileQuery.maybeSingle = profileMaybeSingle

  const blockQuery: Record<string, jest.Mock> = {}
  blockQuery.select = jest.fn(() => blockQuery)
  blockQuery.or = jest.fn(() => blockQuery)
  blockQuery.limit = jest.fn(() => blockQuery)
  blockQuery.abortSignal = jest.fn((signal: AbortSignal) => blockExecute(signal))

  const from = jest.fn((table: string) => {
    if (table === 'user_profiles') return profileQuery
    if (table === 'blocked_users') return blockQuery
    throw new Error(`Unexpected table: ${table}`)
  })

  return {
    supabase: { from },
    __profileMocks: { blockExecute, blockQuery, from, profileMaybeSingle, profileQuery },
  }
})

import { useUserProfile } from '../useUserProfile'

const {
  blockExecute: mockBlockExecute,
  blockQuery: mockBlockQuery,
  from: mockFrom,
  profileMaybeSingle: mockProfileMaybeSingle,
  profileQuery: mockProfileQuery,
} = jest.requireMock('@/lib/supabase/client').__profileMocks as {
  blockExecute: jest.Mock
  blockQuery: Record<string, jest.Mock>
  from: jest.Mock
  profileMaybeSingle: jest.Mock
  profileQuery: Record<string, jest.Mock>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function jwt(userId: string, signature = 'signature'): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.${signature}`
}

function authFor(userId: string, sessionGeneration: number, accessToken = jwt(userId)) {
  return {
    userId,
    email: `${userId}@example.com`,
    accessToken,
    isLoggedIn: true,
    loading: false,
    authChecked: true,
    viewerKey: `user:${userId}`,
    sessionGeneration,
  } as unknown as AuthSessionReturn
}

function setViewer(userId: string, accessToken?: string) {
  const scope = synchronizeViewerScope(true, userId)
  mockAuth = authFor(userId, scope.sessionGeneration, accessToken)
  return scope
}

function setAnonymousViewer() {
  const scope = synchronizeViewerScope(true, null)
  mockAuth = {
    userId: null,
    email: null,
    accessToken: null,
    isLoggedIn: false,
    loading: false,
    authChecked: true,
    viewerKey: 'anon',
    sessionGeneration: scope.sessionGeneration,
  } as unknown as AuthSessionReturn
}

function profileRow(userId: string, handle = userId) {
  return {
    data: {
      id: userId,
      handle,
      bio: `${userId} bio`,
      avatar_url: null,
      cover_url: null,
      show_followers: true,
      show_following: true,
      role: 'user',
    },
    error: null,
  }
}

function serverProfile(id: string, handle = id): ServerProfile {
  return {
    id,
    handle,
    followers: 0,
    following: 0,
    followingTraders: 0,
    isRegistered: true,
    proBadgeTier: null,
  }
}

describe('useUserProfile viewer and provisioning ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockProfileMaybeSingle.mockReset()
    mockBlockExecute.mockReset()
    __resetViewerScopeForTests()
    setViewer('user-a')
    mockBlockExecute.mockResolvedValue({ data: [], error: null })
  })

  it('contains no browser profile mutation or secondary auth source', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(app)/u/[handle]/hooks/useUserProfile.ts'),
      'utf8'
    )

    expect(source).toContain("from '@/lib/hooks/useAuthSession'")
    expect(source).not.toContain('auth.getSession')
    expect(source).not.toContain('auth.getUser')
    expect(source).not.toContain('.insert(')
    expect(source).not.toContain('.upsert(')
    expect(source).not.toContain('.update(')
  })

  it('fails closed when the trigger-provisioned own profile is missing', async () => {
    mockProfileMaybeSingle.mockResolvedValue({ data: null, error: null })
    const hook = renderHook(() =>
      useUserProfile({ handle: 'user-a', serverProfile: null, serverTraderData: null })
    )

    await waitFor(() => expect(mockProfileMaybeSingle).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('loadUserDataFailed', 'error'))
    expect(hook.result.current.profile).toBeNull()
    expect(mockFrom).toHaveBeenCalledWith('user_profiles')
    expect(mockProfileQuery.select).toHaveBeenCalledWith(
      'id, handle, bio, avatar_url, cover_url, show_followers, show_following, role'
    )
  })

  it('hides A synchronously and rejects A after switching the route and viewer to B', async () => {
    const profileA = deferred<ReturnType<typeof profileRow>>()
    mockProfileMaybeSingle
      .mockReturnValueOnce(profileA.promise)
      .mockResolvedValueOnce(profileRow('user-b'))
    const hook = renderHook(
      ({ handle }) => useUserProfile({ handle, serverProfile: null, serverTraderData: null }),
      { initialProps: { handle: 'user-a' } }
    )
    await waitFor(() => expect(mockProfileMaybeSingle).toHaveBeenCalledTimes(1))

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    mockAuth = authFor('user-b', scopeB.sessionGeneration)
    hook.rerender({ handle: 'user-b' })

    expect(hook.result.current.currentUserId).toBe('user-b')
    expect(hook.result.current.email).toBe('user-b@example.com')
    expect(hook.result.current.profile).toBeNull()
    await waitFor(() => expect(hook.result.current.profile?.id).toBe('user-b'))

    await act(async () => {
      profileA.resolve(profileRow('user-a'))
      await profileA.promise
    })
    expect(hook.result.current.profile?.id).toBe('user-b')
    expect(mockRouter.replace).not.toHaveBeenCalled()
  })

  it('invalidates A before React rerenders and exposes no A identity after logout', async () => {
    const profileA = deferred<ReturnType<typeof profileRow>>()
    mockProfileMaybeSingle.mockReturnValue(profileA.promise)
    const hook = renderHook(() =>
      useUserProfile({ handle: 'user-a', serverProfile: null, serverTraderData: null })
    )
    await waitFor(() => expect(mockProfileMaybeSingle).toHaveBeenCalledTimes(1))

    beginViewerTransition(null)
    await act(async () => {
      profileA.resolve(profileRow('user-a'))
      await profileA.promise
    })
    expect(hook.result.current.profile).toBeNull()

    setAnonymousViewer()
    hook.rerender()
    expect(hook.result.current.currentUserId).toBeNull()
    expect(hook.result.current.email).toBeNull()
    expect(hook.result.current.profile).toBeNull()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('hides an already recovered A profile synchronously on logout', async () => {
    mockProfileMaybeSingle.mockResolvedValue(profileRow('user-a'))
    const hook = renderHook(() =>
      useUserProfile({ handle: 'user-a', serverProfile: null, serverTraderData: null })
    )
    await waitFor(() => expect(hook.result.current.profile?.id).toBe('user-a'))

    setAnonymousViewer()
    hook.rerender()

    expect(hook.result.current.currentUserId).toBeNull()
    expect(hook.result.current.email).toBeNull()
    expect(hook.result.current.profile).toBeNull()
    expect(hook.result.current.isOwnProfile).toBe(false)
  })

  it('does not read an own profile when the access-token subject is another user', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scope.sessionGeneration, jwt('user-b'))

    const hook = renderHook(() =>
      useUserProfile({ handle: 'user-a', serverProfile: null, serverTraderData: null })
    )

    await act(async () => Promise.resolve())
    expect(mockProfileMaybeSingle).not.toHaveBeenCalled()
    expect(hook.result.current.currentUserId).toBeNull()
    expect(hook.result.current.profile).toBeNull()
  })

  it('lets only the request started by the current exact token commit', async () => {
    const oldTokenProfile = deferred<ReturnType<typeof profileRow>>()
    mockProfileMaybeSingle
      .mockReturnValueOnce(oldTokenProfile.promise)
      .mockResolvedValueOnce(profileRow('user-a'))
    const hook = renderHook(() =>
      useUserProfile({ handle: 'user-a', serverProfile: null, serverTraderData: null })
    )
    await waitFor(() => expect(mockProfileMaybeSingle).toHaveBeenCalledTimes(1))

    const generation = mockAuth.sessionGeneration
    mockAuth = authFor('user-a', generation, jwt('user-a', 'rotated'))
    hook.rerender()
    await waitFor(() => expect(hook.result.current.profile?.id).toBe('user-a'))

    await act(async () => {
      oldTokenProfile.resolve(profileRow('user-a', 'stale-handle'))
      await oldTokenProfile.promise
    })
    expect(hook.result.current.profile?.handle).toBe('user-a')
    expect(mockRouter.replace).not.toHaveBeenCalled()
  })

  it('aborts and ignores a slow own-profile response after unmount', async () => {
    const slowProfile = deferred<ReturnType<typeof profileRow>>()
    mockProfileMaybeSingle.mockReturnValue(slowProfile.promise)
    const hook = renderHook(() =>
      useUserProfile({ handle: 'user-a', serverProfile: null, serverTraderData: null })
    )
    await waitFor(() => expect(mockProfileQuery.abortSignal).toHaveBeenCalledTimes(1))
    const signal = mockProfileQuery.abortSignal.mock.calls[0][0] as AbortSignal

    hook.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => {
      slowProfile.resolve(profileRow('user-a', 'late-handle'))
      await slowProfile.promise
    })
    expect(mockRouter.replace).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('does not let a late A block result mark B as blocked', async () => {
    const blockA = deferred<{ data: Array<{ blocker_id: string }>; error: null }>()
    mockBlockExecute
      .mockReturnValueOnce(blockA.promise)
      .mockResolvedValueOnce({ data: [], error: null })
    const target = serverProfile('target-user', 'target')
    const hook = renderHook(() =>
      useUserProfile({ handle: 'target', serverProfile: target, serverTraderData: null })
    )
    await waitFor(() => expect(mockBlockExecute).toHaveBeenCalledTimes(1))

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    mockAuth = authFor('user-b', scopeB.sessionGeneration)
    hook.rerender()
    await waitFor(() => expect(mockBlockExecute).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(hook.result.current.isBlocked).toBe(false))

    await act(async () => {
      blockA.resolve({ data: [{ blocker_id: 'user-a' }], error: null })
      await blockA.promise
    })
    expect(hook.result.current.currentUserId).toBe('user-b')
    expect(hook.result.current.isBlocked).toBe(false)
    expect(mockBlockQuery.abortSignal.mock.calls[0][0]).toHaveProperty('aborted', true)
  })
})
