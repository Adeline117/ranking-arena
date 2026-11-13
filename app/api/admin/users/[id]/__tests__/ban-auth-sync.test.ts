/** @jest-environment node */

const mockUpdateUserById = jest.fn()
const mockProfileUpdate = jest.fn()
let profileRow: Record<string, unknown> | null = null

const supabase = {
  auth: { admin: { updateUserById: (...args: unknown[]) => mockUpdateUserById(...args) } },
  from: jest.fn(() => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: profileRow, error: null }) }),
    }),
    update: (values: unknown) => {
      mockProfileUpdate(values)
      return { eq: async () => ({ error: null }) }
    },
  })),
}

jest.mock('@/lib/api/with-admin-auth', () => ({
  withAdminAuth: (handler: Function) => async (request: unknown) => {
    try {
      return await handler({ admin: { id: 'admin-1' }, supabase, request })
    } catch (error) {
      return Response.json(
        { error: (error as Error).message },
        { status: (error as { statusCode?: number }).statusCode ?? 500 }
      )
    }
  },
}))
jest.mock('@/lib/admin/audit-log', () => ({ recordAdminLog: jest.fn() }))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { NextRequest } from 'next/server'
import { POST as ban } from '../ban/route'
import { POST as unban } from '../unban/route'

const call = (route: typeof ban) =>
  route(
    new NextRequest('http://localhost/api/admin/users/user-1/ban', {
      method: 'POST',
      body: JSON.stringify({ reason: 'spam' }),
    }),
    { params: Promise.resolve({ id: 'user-1' }) }
  )

describe('admin ban / unban keep the auth-level ban in sync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpdateUserById.mockResolvedValue({ error: null })
  })

  it('ban blocks sign-in at the auth layer, not just in the profile', async () => {
    profileRow = { id: 'user-1', handle: 'spammer', banned_at: null }

    const response = await call(ban)

    expect(response.status).toBe(200)
    expect(mockProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ banned_by: 'admin-1', banned_reason: 'spam' })
    )
    const [userId, attributes] = mockUpdateUserById.mock.calls[0]
    expect(userId).toBe('user-1')
    expect(attributes.ban_duration).toMatch(/^\d+h$/)
  })

  it('unban lifts the auth-level ban', async () => {
    profileRow = { id: 'user-1', handle: 'spammer', banned_at: '2026-11-01', deleted_at: null }

    const response = await call(unban)

    expect(response.status).toBe(200)
    expect(mockUpdateUserById).toHaveBeenCalledWith('user-1', { ban_duration: 'none' })
    expect(mockProfileUpdate).toHaveBeenCalledWith(expect.objectContaining({ banned_at: null }))
  })

  it('unban leaves a pending-deletion ban in place', async () => {
    profileRow = {
      id: 'user-1',
      handle: 'spammer',
      banned_at: '2026-11-01',
      deleted_at: '2026-11-02',
    }

    const response = await call(unban)

    expect(response.status).toBe(200)
    expect(mockUpdateUserById).not.toHaveBeenCalled()
  })

  it('unban stays retryable when the auth-level ban cannot be lifted', async () => {
    profileRow = { id: 'user-1', handle: 'spammer', banned_at: '2026-11-01', deleted_at: null }
    mockUpdateUserById.mockResolvedValue({ error: { message: 'auth down' } })

    const response = await call(unban)

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(mockProfileUpdate).not.toHaveBeenCalled()
  })
})
