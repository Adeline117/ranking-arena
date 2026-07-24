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
const RELEASE_ID = 'b'.repeat(64)
const ORIGINAL_RELEASE_SHA = process.env.ARENA_RELEASE_SHA
const ORIGINAL_WORKER_RELEASE_ID = process.env.ARENA_WORKER_RELEASE_ID

function request(query = '') {
  return new NextRequest(
    `https://candidate.vercel.app/api/health/worker-release-readiness${query}`,
    {
      headers: { Authorization: 'Bearer test' },
    }
  )
}

describe('GET /api/health/worker-release-readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifyCronSecret.mockReturnValue(true)
    mockGetSharedRedis.mockResolvedValue({ get: mockGet, hgetall: mockHgetall })
    mockGet.mockResolvedValue(null)
    process.env.ARENA_RELEASE_SHA = SHA
    process.env.ARENA_WORKER_RELEASE_ID = RELEASE_ID
    mockHgetall.mockResolvedValue({
      mac: JSON.stringify({
        ts: Date.now(),
        regions: ['local'],
        sha: SHA,
        release_id: RELEASE_ID,
        attempt_bound_capture: true,
      }),
      sg: JSON.stringify({
        ts: Date.now(),
        regions: ['vps_sg'],
        sha: SHA,
        release_id: RELEASE_ID,
        attempt_bound_capture: true,
      }),
    })
  })

  afterAll(() => {
    if (ORIGINAL_RELEASE_SHA === undefined) delete process.env.ARENA_RELEASE_SHA
    else process.env.ARENA_RELEASE_SHA = ORIGINAL_RELEASE_SHA
    if (ORIGINAL_WORKER_RELEASE_ID === undefined) delete process.env.ARENA_WORKER_RELEASE_ID
    else process.env.ARENA_WORKER_RELEASE_ID = ORIGINAL_WORKER_RELEASE_ID
  })

  test('requires service authentication', async () => {
    mockVerifyCronSecret.mockReturnValue(false)

    const response = await GET(request())

    expect(response.status).toBe(401)
    expect(mockGetSharedRedis).not.toHaveBeenCalled()
  })

  test('requires candidate-bound release identities', async () => {
    process.env.ARENA_WORKER_RELEASE_ID = 'abc'
    const response = await GET(request(`?expected_sha=${SHA}&expected_release_id=${RELEASE_ID}`))

    expect(response.status).toBe(503)
    expect(mockGetSharedRedis).not.toHaveBeenCalled()
  })

  test('returns exact live roster evidence without caching', async () => {
    const response = await GET(request())
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mockHgetall).toHaveBeenCalledWith('arena:worker:roster')
    expect(payload).toMatchObject({
      contract: 'arena.worker-release-readiness@2',
      expected_release_id: RELEASE_ID,
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

  test('ignores caller release identities and stays bound to the candidate', async () => {
    const response = await GET(
      request(`?expected_sha=${'d'.repeat(40)}&expected_release_id=${'e'.repeat(64)}`)
    )
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.expected_sha).toBe(SHA)
    expect(payload.expected_release_id).toBe(RELEASE_ID)
    expect(payload.ready).toBe(true)
  })

  test('fails closed when Redis is absent or unreadable', async () => {
    mockGetSharedRedis.mockResolvedValueOnce(null)
    expect((await GET(request())).status).toBe(503)

    mockGetSharedRedis.mockRejectedValueOnce(new Error('redis init down'))
    expect((await GET(request())).status).toBe(503)

    mockHgetall.mockRejectedValueOnce(new Error('redis down'))
    expect((await GET(request())).status).toBe(503)
  })
})
