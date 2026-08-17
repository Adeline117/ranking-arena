import { act, renderHook, waitFor } from '@testing-library/react'
import { useUsers } from '../useUsers'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

const mockAuthedFetch = jest.fn()
const mockFetch = jest.fn()
const ACTOR_B = '22222222-2222-4222-8222-222222222222'
const originalFetch = global.fetch

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
  getCsrfHeaders: () => ({}),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

const ACTOR_A = '11111111-1111-4111-8111-111111111111'

function token(subject: string, marker = 'token'): string {
  const payload = btoa(JSON.stringify({ sub: subject, marker }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${payload}.signature`
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

function user(id: string) {
  return {
    id,
    handle: `user-${id.slice(0, 4)}`,
    email: `${id.slice(0, 4)}***@example.com`,
    avatar_url: null,
    bio: null,
    follower_count: 1,
    following_count: 2,
    role: null,
    banned_at: null,
    banned_reason: null,
    banned_by: null,
    is_banned: false,
    ban_expires_at: null,
    is_effectively_banned: false,
    created_at: '2026-07-18T00:00:00.000Z',
    updated_at: '2026-07-18T00:00:00.000Z',
  }
}

function okResponse(users: Array<ReturnType<typeof user>>, page: number, total: number) {
  const limit = 20
  const offset = (page - 1) * limit
  return {
    ok: true,
    status: 200,
    data: {
      success: true,
      data: users,
      meta: {
        timestamp: '2026-07-18T00:00:00.000Z',
        pagination: {
          limit,
          offset,
          has_more: total > offset + limit,
          total,
        },
      },
    },
  }
}

describe('useUsers', () => {
  beforeAll(() => {
    Object.defineProperty(global, 'fetch', {
      configurable: true,
      value: mockFetch,
    })
  })

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    mockFetch.mockReset()
  })

  afterAll(() => {
    Object.defineProperty(global, 'fetch', {
      configurable: true,
      value: originalFetch,
    })
  })

  it('derives page, totalPages, and ban state fields from the admin users pagination envelope', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    mockAuthedFetch.mockResolvedValue(okResponse([user('a-1')], 2, 45))
    const accessToken = token(ACTOR_A, 'page-two')
    const hook = renderHook(() => useUsers(accessToken))

    await act(async () => {
      await hook.result.current.loadUsers(2, '', 'all')
    })

    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/admin/users?page=2&limit=20&filter=all',
      'GET',
      accessToken,
      undefined,
      15_000,
      expect.objectContaining({
        expectedUserId: ACTOR_A,
        expectedSessionGeneration: expect.any(Number),
      })
    )
    expect(hook.result.current.users).toEqual([user('a-1')])
    expect(hook.result.current.users[0]).toMatchObject({
      is_banned: false,
      ban_expires_at: null,
      is_effectively_banned: false,
    })
    expect(hook.result.current.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
    })
    expect(hook.result.current.error).toBeNull()
  })

  it('keeps effective ban state in sync after local ban and unban acknowledgements', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    mockAuthedFetch.mockResolvedValueOnce(okResponse([user('sync-user')], 1, 1))
    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ success: true }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ success: true }),
      })
    const hook = renderHook(() => useUsers(token(ACTOR_A, 'ban-sync')))

    await act(async () => {
      await hook.result.current.loadUsers(1, '', 'all')
    })

    await act(async () => {
      await expect(hook.result.current.banUser('sync-user', 'policy')).resolves.toBe(true)
    })
    expect(hook.result.current.users[0]).toMatchObject({
      banned_reason: 'policy',
      is_banned: true,
      ban_expires_at: null,
      is_effectively_banned: true,
    })
    expect(hook.result.current.users[0]?.banned_at).toEqual(expect.any(String))

    await act(async () => {
      await expect(hook.result.current.unbanUser('sync-user')).resolves.toBe(true)
    })
    expect(hook.result.current.users[0]).toMatchObject({
      banned_at: null,
      banned_reason: null,
      banned_by: null,
      is_banned: false,
      ban_expires_at: null,
      is_effectively_banned: false,
    })
  })

  it('aborts and ignores an older slower load when a newer request supersedes it', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const first = deferred<ReturnType<typeof okResponse>>()
    const second = deferred<ReturnType<typeof okResponse>>()
    mockAuthedFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const hook = renderHook(() => useUsers(token(ACTOR_A, 'search-race')))

    act(() => {
      void hook.result.current.loadUsers(1, 'alice', 'all')
    })
    await waitFor(() => expect(hook.result.current.loading).toBe(true))
    const firstSignal = mockAuthedFetch.mock.calls[0][5].signal as AbortSignal

    act(() => {
      void hook.result.current.loadUsers(2, 'bob', 'banned')
    })
    expect(firstSignal.aborted).toBe(true)
    const secondSignal = mockAuthedFetch.mock.calls[1][5].signal as AbortSignal
    expect(secondSignal.aborted).toBe(false)

    await act(async () => {
      first.resolve(okResponse([user('old-user')], 1, 40))
      await Promise.resolve()
    })
    expect(hook.result.current.loading).toBe(true)
    expect(hook.result.current.users).toEqual([])

    await act(async () => {
      second.resolve(okResponse([user('new-user')], 2, 21))
      await Promise.resolve()
    })

    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.users).toEqual([user('new-user')])
    expect(hook.result.current.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 21,
      totalPages: 2,
    })
  })

  it('falls back once to the last available page when a requested page is now out of range', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    mockAuthedFetch
      .mockResolvedValueOnce(okResponse([], 3, 40))
      .mockResolvedValueOnce(okResponse([user('last-page-user')], 2, 40))
    const hook = renderHook(() => useUsers(token(ACTOR_A, 'page-fallback')))

    await act(async () => {
      await hook.result.current.loadUsers(3, '', 'all')
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    expect(mockAuthedFetch.mock.calls[0][0]).toBe('/api/admin/users?page=3&limit=20&filter=all')
    expect(mockAuthedFetch.mock.calls[1][0]).toBe('/api/admin/users?page=2&limit=20&filter=all')
    expect(hook.result.current.users).toEqual([user('last-page-user')])
    expect(hook.result.current.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 40,
      totalPages: 2,
    })
  })

  it('ignores a late response after the viewer scope switches to another actor', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const pending = deferred<ReturnType<typeof okResponse>>()
    mockAuthedFetch.mockReturnValueOnce(pending.promise)
    const hook = renderHook(({ accessToken }) => useUsers(accessToken), {
      initialProps: { accessToken: token(ACTOR_A, 'viewer-a') },
    })

    act(() => {
      void hook.result.current.loadUsers(1, '', 'all')
    })
    await waitFor(() => expect(hook.result.current.loading).toBe(true))

    act(() => {
      synchronizeViewerScope(true, ACTOR_B)
      hook.rerender({ accessToken: token(ACTOR_B, 'viewer-b') })
    })

    expect(hook.result.current.users).toEqual([])
    expect(hook.result.current.loading).toBe(false)

    await act(async () => {
      pending.resolve(okResponse([user('stale-user')], 1, 1))
      await Promise.resolve()
    })

    expect(hook.result.current.users).toEqual([])
    expect(hook.result.current.loading).toBe(false)
    expect(hook.result.current.error).toBeNull()
  })

  it('fails closed on a malformed success envelope that omits effective ban fields', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const malformedUser = user('bad-envelope')
    const { is_effectively_banned: _ignored, ...missingEffectiveFlag } = malformedUser
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: [missingEffectiveFlag],
        meta: {
          timestamp: '2026-07-18T00:00:00.000Z',
          pagination: {
            limit: 20,
            offset: 0,
            has_more: false,
            total: 1,
          },
        },
      },
    })
    const hook = renderHook(() => useUsers(token(ACTOR_A, 'invalid-envelope')))

    await act(async () => {
      await hook.result.current.loadUsers(1, '', 'all')
    })

    expect(hook.result.current.users).toEqual([])
    expect(hook.result.current.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    })
    expect(hook.result.current.error).toBe('adminLoadFailed')
  })
})
