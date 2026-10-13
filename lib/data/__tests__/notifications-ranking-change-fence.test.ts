import type { SupabaseClient } from '@supabase/supabase-js'

const mockRpc = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))
jest.mock('@/lib/utils/logger', () => ({
  fireAndForget: jest.fn(),
}))

import { getUnreadNotificationCount, getUserNotificationsWithCount } from '../notifications'

const USER_ID = '11111111-1111-4111-8111-111111111111'

function notification(type: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `${type}-id`,
    user_id: USER_ID,
    type,
    title: `${type} title`,
    message: `${type} message`,
    link: null,
    read: false,
    actor_id: null,
    reference_id: null,
    created_at: '2026-08-17T00:00:00.000Z',
    actor_handle: null,
    actor_avatar_url: null,
    unread_count: 99,
    ...overrides,
  }
}

function visibleUnreadCountQuery(count: number, error: unknown = null) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    neq: jest.fn(),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.neq.mockResolvedValue({ count, error })
  return query
}

const supabase = {
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: (...args: unknown[]) => mockFrom(...args),
} as unknown as SupabaseClient

describe('notification ranking-change reader fence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('drops a legacy ranking_change returned by a stale RPC and recomputes its unread count safely', async () => {
    const countQuery = visibleUnreadCountQuery(2)
    mockFrom.mockReturnValue(countQuery)
    mockRpc.mockResolvedValue({
      data: [notification('ranking_change'), notification('system', { unread_count: 3 })],
      error: null,
    })

    const result = await getUserNotificationsWithCount(supabase, USER_ID, {
      limit: 50,
      offset: 0,
    })

    expect(result).toEqual({
      notifications: [
        expect.objectContaining({
          id: 'system-id',
          type: 'system',
          title: 'system title',
        }),
      ],
      unreadCount: 2,
    })
    expect(mockRpc).toHaveBeenCalledWith('get_user_notifications', {
      p_user_id: USER_ID,
      p_limit: 50,
      p_offset: 0,
      p_unread_only: false,
    })
    expect(mockFrom).toHaveBeenCalledWith('notifications')
    expect(countQuery.eq).toHaveBeenNthCalledWith(1, 'user_id', USER_ID)
    expect(countQuery.eq).toHaveBeenNthCalledWith(2, 'read', false)
    expect(countQuery.neq).toHaveBeenCalledWith('type', 'ranking_change')
  })

  it('keeps safe notifications and the RPC unread count when the proven RPC page contains no suppressed type', async () => {
    mockRpc.mockResolvedValue({
      data: [notification('system', { unread_count: 4 }), notification('follow', { read: true })],
      error: null,
    })

    const result = await getUserNotificationsWithCount(supabase, USER_ID)

    expect(result.notifications.map((item) => item.type)).toEqual(['system', 'follow'])
    expect(result.unreadCount).toBe(4)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('uses the type-fenced count when the RPC page is empty', async () => {
    const countQuery = visibleUnreadCountQuery(0)
    mockFrom.mockReturnValue(countQuery)
    mockRpc.mockResolvedValue({ data: [], error: null })

    await expect(getUserNotificationsWithCount(supabase, USER_ID)).resolves.toEqual({
      notifications: [],
      unreadCount: 0,
    })
    expect(countQuery.neq).toHaveBeenCalledWith('type', 'ranking_change')
  })

  it('never includes legacy ranking_change rows in the standalone unread badge query', async () => {
    const countQuery = visibleUnreadCountQuery(7)
    mockFrom.mockReturnValue(countQuery)

    await expect(getUnreadNotificationCount(supabase, USER_ID)).resolves.toBe(7)

    expect(mockRpc).not.toHaveBeenCalled()
    expect(countQuery.neq).toHaveBeenCalledWith('type', 'ranking_change')
  })
})
