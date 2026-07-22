/** @jest-environment node */

const mockVerifyCronSecret = jest.fn()
const mockGetSharedRedis = jest.fn()
const mockHgetall = jest.fn()
const mockGet = jest.fn()

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: (...args: unknown[]) => mockVerifyCronSecret(...args),
}))

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: (...args: unknown[]) => mockGetSharedRedis(...args),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const SHA = 'a'.repeat(40)

function request(expectedSha = SHA) {
  return new NextRequest(
    `https://candidate.vercel.app/api/health/worker-release-readiness?expected_sha=${expectedSha}`,
    { headers: { Authorization: 'Bearer test' } }
  )
}

describe('GET /api/health/worker-release-readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifyCronSecret.mockReturnValue(true)
    mockGetSharedRedis.mockResolvedValue({ get: mockGet, hgetall: mockHgetall })
    mockGet.mockResolvedValue(null)
    mockHgetall.mockResolvedValue({
      mac: JSON.stringify({
        ts: Date.now(),
        regions: ['local'],
        sha: SHA,
        attempt_bound_capture: true,
      }),
      sg: JSON.stringify({
        ts: Date.now(),
        regions: ['vps_sg'],
        sha: SHA,
        attempt_bound_capture: true,
      }),
    })
  })

  test('requires service authentication', async () => {
    mockVerifyCronSecret.mockReturnValue(false)

    const response = await GET(request())

    expect(response.status).toBe(401)
    expect(mockGetSharedRedis).not.toHaveBeenCalled()
  })

  test('requires a full lowercase expected SHA', async () => {
    const response = await GET(request('abc'))

    expect(response.status).toBe(400)
    expect(mockGetSharedRedis).not.toHaveBeenCalled()
  })

  test('returns exact live roster evidence without caching', async () => {
    const response = await GET(request())
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mockHgetall).toHaveBeenCalledWith('arena:worker:roster')
    expect(payload).toMatchObject({
      contract: 'arena.worker-release-readiness@1',
      expected_sha: SHA,
      failover_regions: [],
      invalid_nodes: [],
      missing_regions: [],
      ready: true,
      required_regions: ['local', 'vps_sg'],
      stale_workers: [],
    })
    expect(mockGet).toHaveBeenCalledWith('arena:failover:regions')
  })

  test('fails closed when Redis is absent or unreadable', async () => {
    mockGetSharedRedis.mockResolvedValueOnce(null)
    expect((await GET(request())).status).toBe(503)

    mockHgetall.mockRejectedValueOnce(new Error('redis down'))
    expect((await GET(request())).status).toBe(503)
  })
})
