/** @jest-environment node */

const mockGetOrSet = jest.fn()
const mockGetUserNotificationsWithCount = jest.fn()
const mockUser = { id: '11111111-1111-4111-8111-111111111111' }
const mockSupabase = {}

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: mockUser, supabase: mockSupabase, request }),
}))
jest.mock('@/lib/cache', () => ({
  getOrSet: (...args: unknown[]) => mockGetOrSet(...args),
  delByPattern: jest.fn(),
}))
jest.mock('@/lib/data/notifications', () => ({
  getUserNotificationsWithCount: (...args: unknown[]) => mockGetUserNotificationsWithCount(...args),
  markNotificationAsRead: jest.fn(),
  markAllNotificationsAsRead: jest.fn(),
  deleteNotification: jest.fn(),
}))
jest.mock('@/lib/features', () => ({ features: { social: false } }))

import { GET } from '../route'

const row = (id: string, type: string, read: boolean) => ({
  id,
  user_id: mockUser.id,
  type,
  title: id,
  message: id,
  read,
  created_at: '2026-08-17T00:00:00.000Z',
})

describe('GET /api/notifications with social features off', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetOrSet.mockImplementation(async (_key: string, loader: () => Promise<unknown>) =>
      loader()
    )
  })

  it('counts only visible unread rows and keeps paging past a filtered page', async () => {
    mockGetUserNotificationsWithCount.mockResolvedValue({
      notifications: [
        row('system-unread', 'system', false),
        row('system-read', 'system', true),
        row('social-like', 'like', false),
      ],
      unreadCount: 2,
    })

    const response = await GET(
      new Request('http://localhost/api/notifications?limit=3&offset=0') as Parameters<
        typeof GET
      >[0]
    )
    const body = await response.json()

    expect(body.data.notifications.map((n: { id: string }) => n.id)).toEqual([
      'system-unread',
      'system-read',
    ])
    // Not 2 (every visible row) and not the DB count that includes the hidden like.
    expect(body.data.unread_count).toBe(1)
    // The DB returned a full page, so there may be more after the filtered one.
    expect(JSON.stringify(body)).toContain('"has_more":true')
  })
})
