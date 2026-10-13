/** @jest-environment node */
const mockVerifyAdmin = jest.fn()
const mockSendToUsers = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: Request) =>
    handler({ user: { id: 'user-a' }, request, supabase: { from: mockFrom } }),
}))
jest.mock('@/lib/admin/auth', () => ({
  getSupabaseAdmin: jest.fn(() => ({ admin: true })),
  verifyAdmin: (...args: unknown[]) => mockVerifyAdmin(...args),
}))
jest.mock('@/lib/services/push-notification', () => ({
  getPushNotificationService: () => ({ sendToUsers: mockSendToUsers }),
}))
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { error: jest.fn() } }))

import { POST } from '../route'

function request(body: Record<string, unknown>, auth = 'Bearer tok') {
  return new Request('https://www.arenafi.org/api/push/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(body),
  })
}

describe('POST /api/push/send', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendToUsers.mockResolvedValue([])
  })

  it('allows self-targeted sends without admin verification', async () => {
    const res = await POST(request({ title: 't', body: 'b' }) as never)
    expect(res.status).toBe(200)
    expect(mockVerifyAdmin).not.toHaveBeenCalled()
    expect(mockSendToUsers).toHaveBeenCalledWith(['user-a'], expect.any(Object))
  })

  it('uses verifyAdmin (not profile.role) for sends to other users', async () => {
    mockVerifyAdmin.mockResolvedValue(null)
    const res = await POST(request({ title: 't', body: 'b', userIds: ['user-b'] }) as never)
    expect(res.status).toBe(403)
    expect(mockVerifyAdmin).toHaveBeenCalledWith({ admin: true }, 'Bearer tok')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockSendToUsers).not.toHaveBeenCalled()
  })

  it('sends to other users when verifyAdmin confirms the caller', async () => {
    mockVerifyAdmin.mockResolvedValue({ id: 'user-a', email: 'a@x.com' })
    const res = await POST(request({ title: 't', body: 'b', userIds: ['user-b'] }) as never)
    expect(res.status).toBe(200)
    expect(mockSendToUsers).toHaveBeenCalledWith(['user-b'], expect.any(Object))
  })

  it('rejects an admin token that belongs to a different user than the session', async () => {
    mockVerifyAdmin.mockResolvedValue({ id: 'someone-else', email: 'a@x.com' })
    const res = await POST(request({ title: 't', body: 'b', userIds: ['user-b'] }) as never)
    expect(res.status).toBe(403)
  })

  it('rejects malformed userIds', async () => {
    const res = await POST(request({ title: 't', body: 'b', userIds: 'user-b' }) as never)
    expect(res.status).toBe(400)
    expect(mockSendToUsers).not.toHaveBeenCalled()
  })
})
