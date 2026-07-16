jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()
    constructor(body: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }
    async json() {
      return this._body
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }
  return { NextResponse: MockNextResponse }
})

const mockReviewClaim = jest.fn()
const mockFrom = jest.fn()
const mockSupabase = { from: mockFrom }
const ADMIN_ID = '22222222-2222-4222-8222-222222222222'

jest.mock('@/lib/data/trader-claims', () => ({
  reviewClaim: (...args: unknown[]) => mockReviewClaim(...args),
}))

jest.mock('@/lib/api/with-admin-auth', () => ({
  withAdminAuth:
    (handler: Function) =>
    async (request: unknown): Promise<unknown> => {
      try {
        return await handler({
          admin: { id: ADMIN_ID, email: 'admin@example.com' },
          supabase: mockSupabase,
          request,
        })
      } catch (error) {
        const { NextResponse } = jest.requireMock('next/server')
        const typed = error as { message?: string; statusCode?: number }
        return NextResponse.json(
          { error: typed.message || 'Internal server error' },
          { status: typed.statusCode || 500 }
        )
      }
    },
}))

jest.mock('@/lib/api/response', () => ({
  success: (data: unknown) => {
    const { NextResponse } = jest.requireMock('next/server')
    return NextResponse.json({ success: true, data })
  },
}))

import type { NextRequest } from 'next/server'
import { POST } from '../route'

const CLAIM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const approvedClaim = {
  id: CLAIM_ID,
  user_id: '11111111-1111-4111-8111-111111111111',
  trader_id: 'trader-1',
  source: 'binance_futures',
  status: 'verified',
}

function request(body: unknown, invalidJson = false): NextRequest {
  return {
    json: invalidJson
      ? jest.fn().mockRejectedValue(new SyntaxError())
      : jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest
}

describe('POST /api/traders/claim/review', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReviewClaim.mockResolvedValue(approvedClaim)
  })

  it('forwards a validated approval without any route-level profile write', async () => {
    const response = await POST(request({ claimId: CLAIM_ID, approved: true }))

    expect(response.status).toBe(200)
    expect(mockReviewClaim).toHaveBeenCalledWith(mockSupabase, CLAIM_ID, ADMIN_ID, true, undefined)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('forwards a bounded rejection reason', async () => {
    await POST(request({ claimId: CLAIM_ID, approved: false, rejectReason: 'ownership mismatch' }))

    expect(mockReviewClaim).toHaveBeenCalledWith(
      mockSupabase,
      CLAIM_ID,
      ADMIN_ID,
      false,
      'ownership mismatch'
    )
  })

  it.each([
    [{ claimId: CLAIM_ID }, 'missing approved'],
    [{ claimId: CLAIM_ID, approved: 'false' }, 'string approved'],
    [{ claimId: 'not-a-uuid', approved: true }, 'malformed claim id'],
    [{ claimId: CLAIM_ID, approved: false, rejectReason: 123 }, 'non-string reject reason'],
    [
      { claimId: CLAIM_ID, approved: false, rejectReason: 'x'.repeat(501) },
      'oversized reject reason',
    ],
  ])('rejects invalid review input before mutation (%s: %s)', async (body) => {
    const response = await POST(request(body))

    expect(response.status).toBe(400)
    expect(mockReviewClaim).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON before mutation', async () => {
    const response = await POST(request(null, true))

    expect(response.status).toBe(400)
    expect(mockReviewClaim).not.toHaveBeenCalled()
  })

  it('maps an ownership conflict to 409', async () => {
    mockReviewClaim.mockRejectedValue({ code: '23505', message: 'identity conflict' })

    const response = await POST(request({ claimId: CLAIM_ID, approved: true }))

    expect(response.status).toBe(409)
  })

  it('maps a missing or terminal claim to 404', async () => {
    mockReviewClaim.mockRejectedValue({ code: 'P0002', message: 'not reviewable' })

    const response = await POST(request({ claimId: CLAIM_ID, approved: false }))

    expect(response.status).toBe(404)
  })
})
