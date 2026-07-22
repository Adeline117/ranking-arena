/**
 * @jest-environment node
 */

const mockCheckRateLimit = jest.fn()
const mockRequireAuth = jest.fn()
const mockFrom = jest.fn()
const mockSelect = jest.fn()
const mockEq = jest.fn()
const mockMaybeSingle = jest.fn()
const mockHandleError = jest.fn((error: unknown) => {
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode: unknown }).statusCode)
      : 500

  return {
    status,
    json: async () => ({ error: String(error) }),
  }
})

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number } = {}) => ({
      status: init.status ?? 200,
      json: async () => body,
    }),
  },
}))

jest.mock('@/lib/api', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: {
    sensitive: { name: 'sensitive' },
    read: { name: 'read' },
  },
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  getSupabaseAdmin: () => ({
    from: (...args: unknown[]) => mockFrom(...args),
  }),
  success: (data: unknown) => ({ status: 200, json: async () => ({ success: true, data }) }),
  handleError: (...args: unknown[]) => mockHandleError(...args),
}))

import type { NextRequest } from 'next/server'
import { RateLimitPresets } from '@/lib/api'
import { GET, POST } from '../route'

function request(url = 'https://arena.test/api/attestation/mint') {
  return { url } as NextRequest
}

describe('/api/attestation/mint quarantine', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockRequireAuth.mockResolvedValue({ id: 'user-1' })
    mockFrom.mockReturnValue({ select: mockSelect })
    mockSelect.mockReturnValue({ eq: mockEq })
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle })
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  })

  describe('POST', () => {
    it('rejects authenticated minting before any attestation or business-data write', async () => {
      const incoming = request()
      const response = await POST(incoming)

      expect(mockCheckRateLimit).toHaveBeenCalledWith(incoming, RateLimitPresets.sensitive)
      expect(mockRequireAuth).toHaveBeenCalledWith(incoming)
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({
        error: 'attestation_minting_unavailable',
        reason: 'trusted_score_evidence_required',
      })
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it('returns a rate-limit response before authentication or business access', async () => {
      const limited = { status: 429, json: async () => ({ error: 'rate_limited' }) }
      mockCheckRateLimit.mockResolvedValueOnce(limited)

      const response = await POST(request())

      expect(response).toBe(limited)
      expect(mockRequireAuth).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it('returns an authentication failure without business access', async () => {
      const authError = Object.assign(new Error('unauthorized'), { statusCode: 401 })
      mockRequireAuth.mockRejectedValueOnce(authError)

      const response = await POST(request())

      expect(response.status).toBe(401)
      expect(mockHandleError).toHaveBeenCalledWith(authError, 'attestation mint')
      expect(mockFrom).not.toHaveBeenCalled()
    })
  })

  describe('GET', () => {
    it('returns null without querying the database when handle is absent', async () => {
      const incoming = request()
      const response = await GET(incoming)

      expect(mockCheckRateLimit).toHaveBeenCalledWith(incoming, RateLimitPresets.read)
      await expect(response.json()).resolves.toEqual({
        success: true,
        data: { attestation: null },
      })
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it('returns the stored attestation for a handle', async () => {
      const attestation = { id: 'attestation-1', trader_handle: 'alice' }
      mockMaybeSingle.mockResolvedValueOnce({ data: attestation, error: null })

      const response = await GET(request('https://arena.test/api/attestation/mint?handle=alice'))

      expect(mockFrom).toHaveBeenCalledWith('trader_attestations')
      expect(mockEq).toHaveBeenCalledWith('trader_handle', 'alice')
      await expect(response.json()).resolves.toEqual({
        success: true,
        data: { attestation },
      })
    })

    it('fails closed when the attestation query fails', async () => {
      const databaseError = { code: 'PGRST000', message: 'database unavailable' }
      mockMaybeSingle.mockResolvedValueOnce({ data: null, error: databaseError })

      const response = await GET(request('https://arena.test/api/attestation/mint?handle=alice'))

      expect(response.status).toBe(500)
      expect(mockHandleError).toHaveBeenCalledWith(databaseError, 'attestation GET')
    })

    it('returns a rate-limit response before reading the database', async () => {
      const limited = { status: 429, json: async () => ({ error: 'rate_limited' }) }
      mockCheckRateLimit.mockResolvedValueOnce(limited)

      const response = await GET(request('https://arena.test/api/attestation/mint?handle=alice'))

      expect(response).toBe(limited)
      expect(mockFrom).not.toHaveBeenCalled()
    })
  })
})
