import { act, renderHook, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import { useInboxStore } from '@/lib/stores/inboxStore'
import { useTopNavState } from '../useTopNavState'

type QueryResult = {
  count?: number | null
  data?: Record<string, unknown> | null
  error?: unknown
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

function token(subject: string, marker = 'token'): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ sub: subject, marker })}.signature`
}

function authFor(userId: string, sessionGeneration: number): AuthSessionReturn {
  return {
    accessToken: token(userId),
    authChecked: true,
    categorizeError: jest.fn(),
    email: `${userId}@example.com`,
    getAuthHeaders: jest.fn(),
    getAuthHeadersAsync: jest.fn(),
    getToken: jest.fn(),
    isLoggedIn: true,
    loading: false,
    refreshSession: jest.fn(),
    requireAuth: jest.fn(),
    sessionGeneration,
    signOut: jest.fn(),
    user: {
      id: userId,
      user_metadata: { avatar_url: `https://img.test/${userId}.png` },
    } as AuthSessionReturn['user'],
    userId,
    viewerKey: `user:${userId}`,
  }
}

function pendingAuth(sessionGeneration: number): AuthSessionReturn {
  return {
    ...authFor('unused', sessionGeneration),
    accessToken: null,
    authChecked: false,
    email: null,
    isLoggedIn: false,
    loading: true,
    user: null,
    userId: null,
    viewerKey: 'pending',
  }
}

let currentAuth: AuthSessionReturn
const queryResults = new Map<string, Array<Promise<QueryResult>>>()
const realtimeCallbacks = new Map<string, () => void>()
const fromMock = jest.fn((table: string) => {
  const nextResult = () => {
    const result = queryResults.get(table)?.shift()
    if (!result) throw new Error(`Missing queued result for ${table}`)
    return result
  }
  const builder = {
    eq: jest.fn(() => builder),
    maybeSingle: jest.fn(() => nextResult()),
    neq: jest.fn(() => builder),
    select: jest.fn(() => builder),
    then: (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
      nextResult().then(resolve, reject),
  }
  return builder
})
const removeChannelMock = jest.fn()
let mockSupabaseAccessError: Error | null = null
let mockSupabaseAccessAttempts = 0
let mockChannelFailureStage: 'channel' | 'on' | 'subscribe' | null = null
let mockChannelFailureTopicPrefix: string | null = null
let mockChannelStageAttempts = { channel: 0, on: 0, subscribe: 0 }
type MockRealtimeChannel = {
  on: jest.Mock
  subscribe: jest.Mock
  topic: string
}
const registeredChannels: MockRealtimeChannel[] = []
const shouldFailChannelStage = (stage: 'channel' | 'on' | 'subscribe', name: string): boolean =>
  mockChannelFailureStage === stage &&
  (!mockChannelFailureTopicPrefix || name.startsWith(mockChannelFailureTopicPrefix))
const channelMock = jest.fn((name: string) => {
  mockChannelStageAttempts.channel += 1
  if (shouldFailChannelStage('channel', name)) throw new Error('channel creation failed')
  const existing = registeredChannels.find((candidate) => candidate.topic === `realtime:${name}`)
  if (existing) return existing
  const channel: MockRealtimeChannel = {
    topic: `realtime:${name}`,
    on: jest.fn((_event: string, _config: Record<string, unknown>, callback: () => void) => {
      mockChannelStageAttempts.on += 1
      if (shouldFailChannelStage('on', name)) throw new Error('channel handler failed')
      realtimeCallbacks.set(name, callback)
      return channel
    }),
    subscribe: jest.fn(() => {
      mockChannelStageAttempts.subscribe += 1
      if (shouldFailChannelStage('subscribe', name)) {
        throw new Error('channel subscribe failed')
      }
      return channel
    }),
  }
  registeredChannels.push(channel)
  return channel
})

function realtimeCallback(prefix: string): (() => void) | undefined {
  return [...realtimeCallbacks.entries()].find(([name]) => name.startsWith(prefix))?.[1]
}

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => currentAuth,
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: jest.fn(),
}))

jest.mock('@/lib/supabase/client', () => ({
  get supabase() {
    mockSupabaseAccessAttempts += 1
    if (mockSupabaseAccessError) throw mockSupabaseAccessError
    return {
      channel: (...args: [string]) => channelMock(...args),
      from: (...args: [string]) => fromMock(...args),
      getChannels: () => [...registeredChannels],
      removeChannel: (...args: unknown[]) => removeChannelMock(...args),
    }
  },
}))

function queue(table: string, result: QueryResult | Promise<QueryResult>): void {
  const items = queryResults.get(table) ?? []
  items.push(Promise.resolve(result))
  queryResults.set(table, items)
}

describe('useTopNavState viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    queryResults.clear()
    realtimeCallbacks.clear()
    registeredChannels.splice(0)
    mockSupabaseAccessError = null
    mockSupabaseAccessAttempts = 0
    mockChannelFailureStage = null
    mockChannelFailureTopicPrefix = null
    mockChannelStageAttempts = { channel: 0, on: 0, subscribe: 0 }
    removeChannelMock.mockImplementation(async (channel: MockRealtimeChannel) => {
      const index = registeredChannels.indexOf(channel)
      if (index >= 0) registeredChannels.splice(index, 1)
      return 'ok'
    })
    __resetViewerScopeForTests()
    useInboxStore.setState({
      ownerScopeKey: null,
      panelOpen: false,
      unreadMessages: 0,
      unreadNotifications: 0,
    })
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: (callback: () => void) => {
        callback()
        return 1
      },
    })
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      value: jest.fn(),
    })
  })

  it('fails empty on A → pending/B and never carries A email/menu/badge into B', async () => {
    const scopeA = synchronizeViewerScope(true, 'user-a')
    currentAuth = authFor('user-a', scopeA.sessionGeneration)
    queue('user_profiles', { data: { avatar_url: null, handle: 'alice' } })
    queue('notifications', { count: 6, error: null })
    queue('direct_messages', { count: 3, error: null })

    const view = renderHook(() => useTopNavState())
    await waitFor(() => expect(view.result.current.myHandle).toBe('alice'))
    await waitFor(() => expect(view.result.current.totalUnread).toBe(9))
    act(() => view.result.current.setShowUserMenu(true))
    expect(view.result.current.showUserMenu).toBe(true)
    expect(view.result.current.myEmail).toBe('user-a@example.com')

    const transition = beginViewerTransition('user-b')
    currentAuth = pendingAuth(transition)
    view.rerender()
    expect(view.result.current).toMatchObject({
      authPending: true,
      myAvatarUrl: null,
      myEmail: null,
      myHandle: null,
      myId: null,
      showUserMenu: false,
      totalUnread: 0,
    })

    const scopeB = commitViewerTransition(transition, 'user-b')!
    const profileB = deferred<QueryResult>()
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    queue('user_profiles', profileB.promise)
    queue('notifications', { count: 2, error: null })
    queue('direct_messages', { count: 1, error: null })
    view.rerender()

    expect(view.result.current).toMatchObject({
      myAvatarUrl: 'https://img.test/user-b.png',
      myEmail: 'user-b@example.com',
      myHandle: 'user-b',
      myId: 'user-b',
      profileLoading: true,
      showUserMenu: false,
    })
    expect(view.result.current.myEmail).not.toContain('user-a')
    await waitFor(() => expect(view.result.current.totalUnread).toBe(3))
    expect(view.result.current.profileLoading).toBe(true)

    profileB.resolve({ data: { avatar_url: null, handle: 'bob' } })
    await waitFor(() => expect(view.result.current.myHandle).toBe('bob'))
    expect(view.result.current.profileLoading).toBe(false)
    await waitFor(() => expect(view.result.current.totalUnread).toBe(3))
  })

  it('rejects a delayed A profile completion after B owns the hook', async () => {
    const scopeA = synchronizeViewerScope(true, 'user-a')
    currentAuth = authFor('user-a', scopeA.sessionGeneration)
    const profileA = deferred<QueryResult>()
    queue('user_profiles', profileA.promise)

    const view = renderHook(() => useTopNavState())
    await waitFor(() => expect(fromMock).toHaveBeenCalledWith('user_profiles'))

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    queue('user_profiles', { data: { avatar_url: null, handle: 'bob' } })
    queue('notifications', { count: 1, error: null })
    queue('direct_messages', { count: 0, error: null })
    view.rerender()
    await waitFor(() => expect(view.result.current.myHandle).toBe('bob'))

    profileA.resolve({ data: { avatar_url: 'https://a.test/avatar.png', handle: 'alice' } })
    await act(async () => {
      await profileA.promise
      await Promise.resolve()
    })
    expect(view.result.current).toMatchObject({
      myAvatarUrl: 'https://img.test/user-b.png',
      myEmail: 'user-b@example.com',
      myHandle: 'bob',
      myId: 'user-b',
    })
  })

  it('rejects an old realtime callback and isolates a new generation of the same user', async () => {
    const firstScope = synchronizeViewerScope(true, 'user-a')
    currentAuth = authFor('user-a', firstScope.sessionGeneration)
    queue('user_profiles', { data: { avatar_url: null, handle: 'alice' } })
    queue('notifications', { count: 4, error: null })
    queue('direct_messages', { count: 0, error: null })

    const view = renderHook(() => useTopNavState())
    await waitFor(() => expect(view.result.current.totalUnread).toBe(4))
    const oldCallback = realtimeCallback(`notifications:user-a:${firstScope.sessionGeneration}:`)
    expect(oldCallback).toBeDefined()

    const transition = beginViewerTransition('user-a')
    const secondScope = commitViewerTransition(transition, 'user-a')!
    currentAuth = authFor('user-a', secondScope.sessionGeneration)
    const secondProfile = deferred<QueryResult>()
    queue('user_profiles', secondProfile.promise)
    queue('notifications', { count: 2, error: null })
    queue('direct_messages', { count: 0, error: null })
    view.rerender()

    expect(view.result.current.totalUnread).toBe(0)
    act(() => oldCallback?.())
    expect(queryResults.get('notifications')).toHaveLength(1)
    expect(view.result.current.totalUnread).toBe(0)

    secondProfile.resolve({ data: { avatar_url: null, handle: 'alice-new-session' } })
    await waitFor(() => expect(view.result.current.myHandle).toBe('alice-new-session'))
    await waitFor(() => expect(view.result.current.totalUnread).toBe(2))
  })

  it('keeps the canonical viewer usable from safe fallbacks when profile never settles', async () => {
    const scope = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scope.sessionGeneration)
    const profileNeverReturns = deferred<QueryResult>()
    queue('user_profiles', profileNeverReturns.promise)
    queue('notifications', { count: 2, error: null })
    queue('direct_messages', { count: 1, error: null })

    const view = renderHook(() => useTopNavState())

    await waitFor(() =>
      expect(view.result.current).toMatchObject({
        authPending: false,
        myAvatarUrl: 'https://img.test/user-b.png',
        myEmail: 'user-b@example.com',
        myHandle: 'user-b',
        myId: 'user-b',
        profileLoading: true,
        totalUnread: 3,
      })
    )
    expect(view.result.current.myEmail).not.toContain('user-a')
    expect(view.result.current.myHandle).not.toContain('user-a')
    view.unmount()
  })

  it('consumes Supabase import and channel setup failures without an unhandled rejection', async () => {
    const scope = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scope.sessionGeneration)
    mockSupabaseAccessError = new Error('supabase chunk failed')
    const unhandledRejection = jest.fn()
    process.on('unhandledRejection', unhandledRejection)

    const view = renderHook(() => useTopNavState())
    try {
      await waitFor(() => expect(view.result.current.profileLoading).toBe(false))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(mockSupabaseAccessAttempts).toBeGreaterThan(0)
      expect(fromMock).not.toHaveBeenCalled()
      expect(channelMock).not.toHaveBeenCalled()
      expect(unhandledRejection).not.toHaveBeenCalled()
    } finally {
      view.unmount()
      process.removeListener('unhandledRejection', unhandledRejection)
    }
  })

  it.each(['channel', 'on', 'subscribe'] as const)(
    'consumes a synchronous realtime %s failure without an unhandled rejection',
    async (failureStage) => {
      const scope = synchronizeViewerScope(true, 'user-b')
      currentAuth = authFor('user-b', scope.sessionGeneration)
      queue('user_profiles', { data: { avatar_url: null, handle: 'bob' } })
      queue('notifications', { count: 2, error: null })
      queue('direct_messages', { count: 1, error: null })
      mockChannelFailureStage = failureStage
      const unhandledRejection = jest.fn()
      process.on('unhandledRejection', unhandledRejection)

      const view = renderHook(() => useTopNavState())
      try {
        await waitFor(() => expect(view.result.current.totalUnread).toBe(3))
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        expect(mockChannelStageAttempts[failureStage]).toBeGreaterThan(0)
        await waitFor(() => expect(registeredChannels).toHaveLength(0))
        expect(unhandledRejection).not.toHaveBeenCalled()
      } finally {
        view.unmount()
        process.removeListener('unhandledRejection', unhandledRejection)
      }
    }
  )

  it('keeps the notification subscription when the message subscription fails', async () => {
    const scope = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scope.sessionGeneration)
    queue('user_profiles', { data: { avatar_url: null, handle: 'bob' } })
    queue('notifications', { count: 2, error: null })
    queue('direct_messages', { count: 1, error: null })
    mockChannelFailureStage = 'subscribe'
    mockChannelFailureTopicPrefix = 'messages:'
    const unhandledRejection = jest.fn()
    process.on('unhandledRejection', unhandledRejection)

    const view = renderHook(() => useTopNavState())
    try {
      await waitFor(() => expect(view.result.current.totalUnread).toBe(3))
      await waitFor(() => expect(mockChannelStageAttempts.subscribe).toBe(2))
      await waitFor(() => expect(registeredChannels).toHaveLength(1))
      expect(registeredChannels[0]?.topic).toMatch(/^realtime:notifications:/)

      const removedBeforeUnmount = removeChannelMock.mock.calls.map(
        ([channel]) => (channel as MockRealtimeChannel).topic
      )
      expect(
        removedBeforeUnmount.some((topic) => topic.startsWith('realtime:notifications:'))
      ).toBe(false)
      expect(removedBeforeUnmount.some((topic) => topic.startsWith('realtime:messages:'))).toBe(
        true
      )
      expect(unhandledRejection).not.toHaveBeenCalled()

      view.unmount()
      await waitFor(() => expect(registeredChannels).toHaveLength(0))
      const removedAfterUnmount = removeChannelMock.mock.calls.map(
        ([channel]) => (channel as MockRealtimeChannel).topic
      )
      expect(removedAfterUnmount.some((topic) => topic.startsWith('realtime:notifications:'))).toBe(
        true
      )
    } finally {
      view.unmount()
      process.removeListener('unhandledRejection', unhandledRejection)
    }
  })

  it('keeps the message subscription when the notification subscription fails', async () => {
    const scope = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scope.sessionGeneration)
    queue('user_profiles', { data: { avatar_url: null, handle: 'bob' } })
    queue('notifications', { count: 2, error: null })
    queue('direct_messages', { count: 1, error: null })
    mockChannelFailureStage = 'subscribe'
    mockChannelFailureTopicPrefix = 'notifications:'
    const unhandledRejection = jest.fn()
    process.on('unhandledRejection', unhandledRejection)

    const view = renderHook(() => useTopNavState())
    try {
      await waitFor(() => expect(view.result.current.totalUnread).toBe(3))
      await waitFor(() => expect(mockChannelStageAttempts.subscribe).toBe(2))
      await waitFor(() => expect(registeredChannels).toHaveLength(1))
      expect(registeredChannels[0]?.topic).toMatch(/^realtime:messages:/)

      const removedBeforeUnmount = removeChannelMock.mock.calls.map(
        ([channel]) => (channel as MockRealtimeChannel).topic
      )
      expect(
        removedBeforeUnmount.some((topic) => topic.startsWith('realtime:notifications:'))
      ).toBe(true)
      expect(removedBeforeUnmount.some((topic) => topic.startsWith('realtime:messages:'))).toBe(
        false
      )
      expect(unhandledRejection).not.toHaveBeenCalled()

      view.unmount()
      await waitFor(() => expect(registeredChannels).toHaveLength(0))
      const removedAfterUnmount = removeChannelMock.mock.calls.map(
        ([channel]) => (channel as MockRealtimeChannel).topic
      )
      expect(removedAfterUnmount.some((topic) => topic.startsWith('realtime:messages:'))).toBe(true)
    } finally {
      view.unmount()
      process.removeListener('unhandledRejection', unhandledRejection)
    }
  })

  it('consumes both realtime recount failures and preserves the scoped badge', async () => {
    const scope = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scope.sessionGeneration)
    queue('user_profiles', { data: { avatar_url: null, handle: 'bob' } })
    queue('notifications', { count: 2, error: null })
    queue('direct_messages', { count: 1, error: null })
    const unhandledRejection = jest.fn()
    process.on('unhandledRejection', unhandledRejection)

    const view = renderHook(() => useTopNavState())
    try {
      await waitFor(() => expect(view.result.current.totalUnread).toBe(3))
      const notificationCallback = realtimeCallback(
        `notifications:user-b:${scope.sessionGeneration}:`
      )
      const messageCallback = realtimeCallback(`messages:user-b:${scope.sessionGeneration}:`)
      expect(notificationCallback).toBeDefined()
      expect(messageCallback).toBeDefined()

      const notificationFailure = deferred<QueryResult>()
      const messageFailure = deferred<QueryResult>()
      queue('notifications', notificationFailure.promise)
      queue('direct_messages', messageFailure.promise)

      act(() => {
        notificationCallback?.()
        messageCallback?.()
        notificationFailure.reject(new Error('notification recount failed'))
        messageFailure.reject(new Error('message recount failed'))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(unhandledRejection).not.toHaveBeenCalled()
      expect(view.result.current.totalUnread).toBe(3)
    } finally {
      view.unmount()
      process.removeListener('unhandledRejection', unhandledRejection)
    }
  })
})
