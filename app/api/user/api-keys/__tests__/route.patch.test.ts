/** @jest-environment node */

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private body: unknown

    constructor(body: unknown, init: ResponseInit = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const KEY_ID = '10000000-0000-4000-8000-000000000001'
const mockSingle = jest.fn()
const mockSelect = jest.fn(() => ({ single: mockSingle }))
const mockUserEq = jest.fn(() => ({ select: mockSelect }))
const mockIdEq = jest.fn(() => ({ eq: mockUserEq }))
const mockUpdate = jest.fn(() => ({ eq: mockIdEq }))
const mockFrom = jest.fn(() => ({ update: mockUpdate }))

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: { json: () => Promise<unknown> }) =>
    handler({
      user: { id: 'user-paid' },
      request,
      supabase: { from: mockFrom },
    }),
}))

import { PATCH } from '../route'

function request(body: unknown) {
  return { json: jest.fn().mockResolvedValue(body) } as never
}

describe('PATCH /api/user/api-keys', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSingle.mockImplementation(async () => {
      const revokedAt = mockUpdate.mock.calls[0]?.[0]?.revoked_at
      return {
        data: { id: KEY_ID, active: false, revoked_at: revokedAt },
        error: null,
      }
    })
  })

  it('returns the exact persisted revocation acknowledgement', async () => {
    const response = await PATCH(request({ id: KEY_ID }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: {
        id: KEY_ID,
        active: false,
        revoked_at: expect.any(String),
      },
    })
    expect(mockIdEq).toHaveBeenCalledWith('id', KEY_ID)
    expect(mockUserEq).toHaveBeenCalledWith('user_id', 'user-paid')
    expect(mockSelect).toHaveBeenCalledWith('id, active, revoked_at')
  })

  it.each([
    { id: '20000000-0000-4000-8000-000000000002', active: false },
    { id: KEY_ID, active: true },
  ])('rejects an inconsistent database acknowledgement: %p', async (partialRow) => {
    mockSingle.mockImplementationOnce(async () => ({
      data: {
        ...partialRow,
        revoked_at: mockUpdate.mock.calls[0]?.[0]?.revoked_at,
      },
      error: null,
    }))

    const response = await PATCH(request({ id: KEY_ID }))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to acknowledge API key revocation',
    })
  })

  it('rejects a revocation timestamp that differs from the committed intent', async () => {
    mockSingle.mockResolvedValueOnce({
      data: { id: KEY_ID, active: false, revoked_at: '2020-01-01T00:00:00.000Z' },
      error: null,
    })

    const response = await PATCH(request({ id: KEY_ID }))

    expect(response.status).toBe(500)
  })
})
