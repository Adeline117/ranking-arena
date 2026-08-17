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
jest.mock('@/lib/features', () => ({ features: { social: true } }))

import { GET } from '../route'

describe('GET /api/notifications ranking-change cache fence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetOrSet.mockImplementation(async (_key: string, loader: () => Promise<unknown>) =>
      loader()
    )
    mockGetUserNotificationsWithCount.mockResolvedValue({
      notifications: [
        {
          id: 'safe-system',
          user_id: mockUser.id,
          type: 'system',
          title: 'Safe system notice',
          message: 'No ranking payload',
          read: false,
          created_at: '2026-08-17T00:00:00.000Z',
        },
      ],
      unreadCount: 1,
    })
  })

  it('uses a new cache namespace and returns only the fenced helper result', async () => {
    const response = await GET(
      new Request('http://localhost/api/notifications?limit=20&offset=0') as Parameters<
        typeof GET
      >[0]
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.notifications).toEqual([
      expect.objectContaining({ id: 'safe-system', type: 'system' }),
    ])
    expect(mockGetOrSet).toHaveBeenCalledWith(
      'notifications:11111111-1111-4111-8111-111111111111:ranking-change-fence-v1:20:0:false',
      expect.any(Function),
      { ttl: 30 }
    )
    expect(mockGetUserNotificationsWithCount).toHaveBeenCalledWith(mockSupabase, mockUser.id, {
      limit: 20,
      offset: 0,
      unread_only: false,
    })
  })
})
