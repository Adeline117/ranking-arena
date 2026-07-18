/**
 * @jest-environment node
 */

import type { FreshnessReport } from '@/lib/rankings/freshness-report'

const mockVerifyAdminAuth = jest.fn()
const mockBuildFreshnessReport = jest.fn()
const mockCronGet = jest.fn()
const mockSendRateLimitedAlert = jest.fn()
const mockLogError = jest.fn()

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyAdminAuth: (...args: unknown[]) => mockVerifyAdminAuth(...args),
}))

jest.mock('@/app/api/cron/check-data-freshness/route', () => ({
  buildFreshnessReport: (...args: unknown[]) => mockBuildFreshnessReport(...args),
  GET: (...args: unknown[]) => mockCronGet(...args),
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockSendRateLimitedAlert(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockLogError(...args),
  }),
}))

import { GET } from '../route'

const REPORT = {
  ok: false,
  checked_at: '2026-07-18T12:00:00.000Z',
  summary: {
    total: 2,
    fresh: 1,
    stale: 0,
    critical: 0,
    unknown: 1,
  },
  thresholds: {
    stale_hours: 8,
    critical_hours: 24,
  },
  platforms: [
    {
      platform: 'binance_futures',
      displayName: 'Binance Futures',
      lastUpdate: '2026-07-18T11:30:00.000Z',
      ageMs: 1_800_000,
      ageHours: 0.5,
      status: 'fresh',
      recordCount: 500,
    },
    {
      platform: 'gmx',
      displayName: 'GMX',
      lastUpdate: null,
      ageMs: null,
      ageHours: null,
      status: 'unknown',
      recordCount: 0,
    },
  ],
} satisfies FreshnessReport

function request() {
  return new Request('http://localhost:3000/api/admin/data-freshness', {
    headers: { authorization: 'Bearer admin-jwt' },
  })
}

describe('GET /api/admin/data-freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects an unauthorized request before building a report', async () => {
    mockVerifyAdminAuth.mockResolvedValue(false)

    const response = await GET(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' })
    expect(mockVerifyAdminAuth).toHaveBeenCalledWith(expect.any(Request))
    expect(mockBuildFreshnessReport).not.toHaveBeenCalled()
    expect(mockCronGet).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it('returns the shared freshness report to an authorized admin', async () => {
    mockVerifyAdminAuth.mockResolvedValue(true)
    mockBuildFreshnessReport.mockResolvedValue(REPORT)

    const response = await GET(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(REPORT)
    expect(mockBuildFreshnessReport).toHaveBeenCalledTimes(1)
    expect(mockCronGet).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it('masks a report-builder failure in the 500 response', async () => {
    mockVerifyAdminAuth.mockResolvedValue(true)
    mockBuildFreshnessReport.mockRejectedValue(
      new Error('postgres://service-role:super-secret@private-host')
    )

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    })
    expect(JSON.stringify(body)).not.toContain('super-secret')
    expect(mockLogError).toHaveBeenCalledWith('postgres://service-role:super-secret@private-host')
    expect(mockCronGet).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })
})
