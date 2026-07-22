/**
 * @jest-environment node
 */

const mockFrom = jest.fn()

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number } = {}) => ({
      status: init.status ?? 200,
      json: async () => body,
    }),
  },
}))

jest.mock('@/lib/api', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { sensitive: {}, read: {} },
  requireAuth: jest.fn().mockResolvedValue({ id: 'user-1' }),
  getSupabaseAdmin: () => ({
    from: (...args: unknown[]) => mockFrom(...args),
  }),
  success: (data: unknown) => ({ status: 200, json: async () => ({ success: true, data }) }),
  handleError: (error: unknown) => ({ status: 500, json: async () => ({ error: String(error) }) }),
}))

import type { NextRequest } from 'next/server'
import { POST } from '../route'

async function mint() {
  return POST({} as NextRequest)
}

describe('POST /api/attestation/mint quarantine', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects every authenticated mint before any database or external write', async () => {
    const response = await mint()

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'attestation_minting_unavailable',
      reason: 'trusted_score_evidence_required',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
