/**
 * Cron: refresh-leaderboard-cache route tests
 * Tests auth, cache refresh for all periods, and error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/lib/getInitialTraders', () => ({
  fetchLeaderboardFromDB: jest.fn(),
}))

jest.mock('@/lib/cache/leaderboard-cache', () => ({
  setCachedLeaderboard: jest.fn(),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(() =>
      Promise.resolve({ success: jest.fn(), error: jest.fn(), timeout: jest.fn() })
    ),
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'
import { fetchLeaderboardFromDB } from '@/lib/getInitialTraders'
import { setCachedLeaderboard } from '@/lib/cache/leaderboard-cache'

const mockFetchLeaderboardFromDB = fetchLeaderboardFromDB as jest.MockedFunction<typeof fetchLeaderboardFromDB>
const mockSetCachedLeaderboard = setCachedLeaderboard as jest.MockedFunction<typeof setCachedLeaderboard>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/refresh-leaderboard-cache', { headers })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/refresh-leaderboard-cache', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ---- Auth ----------------------------------------------------------------

  it('returns 401 when CRON_SECRET is missing', async () => {
    const res = await GET(createCronRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 when secret does not match', async () => {
    const res = await GET(createCronRequest('wrong'))
    expect(res.status).toBe(401)
  })

  // ---- Successful execution ------------------------------------------------

  it('refreshes cache for all three periods', async () => {
    const mockTraders = [
      { id: '1', name: 'Trader1', roi: 50 },
      { id: '2', name: 'Trader2', roi: 30 },
    ]
    const lastUpdated = new Date().toISOString()

    mockFetchLeaderboardFromDB.mockResolvedValue({ traders: mockTraders, lastUpdated })
    mockSetCachedLeaderboard.mockResolvedValue(undefined)

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.periods['90D'].traders).toBe(2)
    expect(body.periods['30D'].traders).toBe(2)
    expect(body.periods['7D'].traders).toBe(2)
    expect(mockFetchLeaderboardFromDB).toHaveBeenCalledTimes(3)
    expect(mockSetCachedLeaderboard).toHaveBeenCalledTimes(3)
  })

  // ---- Partial failure -----------------------------------------------------

  it('reports errors when some periods fail', async () => {
    let callCount = 0
    mockFetchLeaderboardFromDB.mockImplementation(() => {
      callCount++
      if (callCount === 2) throw new Error('DB timeout')
      return { traders: [{ id: '1' }], lastUpdated: new Date().toISOString() }
    })
    mockSetCachedLeaderboard.mockResolvedValue(undefined)

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    // One period should have an error
    const periodsWithError = Object.values(body.periods).filter(
      (p: any) => p.error
    )
    expect(periodsWithError.length).toBe(1)
  })

  // ---- All periods fail ----------------------------------------------------

  it('handles all periods failing', async () => {
    mockFetchLeaderboardFromDB.mockRejectedValue(new Error('DB down'))

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true) // Route still returns 200 with error details per period
    const allErrored = Object.values(body.periods).every((p: any) => p.error)
    expect(allErrored).toBe(true)
  })
})
