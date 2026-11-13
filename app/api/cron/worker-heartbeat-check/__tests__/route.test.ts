/** @jest-environment node */

const mockSendAlert = jest.fn()
const mockHdel = jest.fn()
const mockHgetall = jest.fn()
let mockRedisUnavailable = false

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    try {
      const result = await handler(request, {})
      return Response.json({ ok: true, ...result })
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 })
    }
  },
}))

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: async () =>
    mockRedisUnavailable ? null : { hdel: mockHdel, hgetall: mockHgetall },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockSendAlert(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const NOW = Date.parse('2026-07-24T08:00:00.000Z')
const RELEASE_ID = 'a'.repeat(64)
const SHA = 'b'.repeat(40)
const OTHER_SHA = 'c'.repeat(40)

function beat(
  regions: unknown,
  options: {
    attemptBoundCapture?: boolean
    releaseId?: string
    sha?: string
    ts?: unknown
  } = {}
) {
  return JSON.stringify({
    attempt_bound_capture: options.attemptBoundCapture ?? true,
    regions,
    release_id: options.releaseId ?? RELEASE_ID,
    sha: options.sha ?? SHA,
    ts: options.ts ?? NOW - 30_000,
  })
}

async function run(roster: Record<string, unknown>) {
  mockHgetall.mockResolvedValueOnce(roster)
  return GET(new NextRequest('http://localhost/api/cron/worker-heartbeat-check'))
}

function topologyAlert() {
  return mockSendAlert.mock.calls.find((call) => call[1] === 'worker-heartbeat:topology')
}

describe('GET /api/cron/worker-heartbeat-check topology invariant', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    mockHdel.mockResolvedValue(1)
    mockSendAlert.mockResolvedValue({ channels: [], rateLimited: false, sent: false })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('alerts with unknown, duplicate, combined-owner, and disabled-capture evidence', async () => {
    const response = await run({
      combined: beat(['local', 'vps_sg']),
      duplicateDisabled: beat(['local'], { attemptBoundCapture: false }),
      unknown: beat(['local'], { releaseId: 'unknown' }),
    })
    expect(response.status).toBe(200)

    const alert = topologyAlert()
    expect(alert).toBeDefined()
    expect(alert?.[0]).toMatchObject({
      level: 'critical',
      details: {
        topology: {
          capture_disabled_nodes: ['duplicateDisabled'],
          combined_owner_nodes: ['combined'],
          duplicate_regions: ['local'],
          invalid_release_nodes: ['unknown'],
          ready: false,
        },
      },
    })
  })

  test('malformed regions and timestamps are isolated instead of aborting the cron', async () => {
    const response = await run({
      badRegions: beat({ local: true }),
      badTs: { regions: ['local'], ts: Number.NaN },
      mac: beat(['local']),
      sg: beat(['vps_sg']),
    })
    const body = await response.json()

    expect(body.ok).toBe(true)
    expect(body.topology.invalid_nodes).toEqual([
      { node: 'badRegions', reason: 'invalid_regions' },
      { node: 'badTs', reason: 'invalid_ts' },
    ])
    expect(mockHdel).toHaveBeenCalledTimes(2)
    expect(topologyAlert()).toBeDefined()
  })

  test('allows one release across owners with different audit SHAs', async () => {
    const response = await run({
      mac: beat(['local']),
      sg: beat(['vps_sg'], { sha: OTHER_SHA }),
      'scoring@mac': beat(['scoring'], { attemptBoundCapture: false }),
    })
    const body = await response.json()

    expect(body.topology).toMatchObject({
      distinct_release_ids: [RELEASE_ID],
      ready: true,
    })
    expect(topologyAlert()).toBeUndefined()
    expect(mockSendAlert).not.toHaveBeenCalled()
  })
})

describe('GET /api/cron/worker-heartbeat-check scoring process coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    mockHdel.mockResolvedValue(1)
    mockSendAlert.mockResolvedValue({ channels: [], rateLimited: false, sent: true })
  })
  afterEach(() => jest.restoreAllMocks())

  const scoringAlert = () =>
    mockSendAlert.mock.calls.find((c) => c[1] === 'worker-heartbeat:scoring')

  test('pages when no scoring heartbeat exists even though crawlers are healthy', async () => {
    await run({ mac: beat(['local']), sg: beat(['vps_sg']) })
    expect(scoringAlert()?.[0]).toMatchObject({ level: 'critical' })
  })

  test('pages with the stale scoring node and keeps it out of crawl coverage', async () => {
    const response = await run({
      mac: beat(['local']),
      sg: beat(['vps_sg']),
      'scoring@mac': beat(['scoring'], { ts: NOW - 30 * 60_000 }),
    })
    const body = await response.json()
    expect(scoringAlert()?.[0].message).toContain('scoring@mac')
    expect(body.down).toEqual([])
    expect(body.scoring.down).toEqual([{ node: 'scoring@mac', age_min: 30 }])
  })

  test('a healthy scoring beat with a different release does not trip ingest drift', async () => {
    const response = await run({
      mac: beat(['local']),
      sg: beat(['vps_sg']),
      'scoring@mac': beat(['scoring'], { releaseId: 'unknown', attemptBoundCapture: false }),
    })
    const body = await response.json()
    expect(scoringAlert()).toBeUndefined()
    expect(mockSendAlert).not.toHaveBeenCalled()
    expect(body.topology.scoring_nodes).toEqual(['scoring@mac'])
    expect(body.topology.ready).toBe(true)
  })
})

describe('GET /api/cron/worker-heartbeat-check when blind', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendAlert.mockResolvedValue({ channels: [], rateLimited: false, sent: true })
  })
  afterEach(() => {
    mockRedisUnavailable = false
  })

  test('pages and fails the run when Redis is unavailable', async () => {
    mockRedisUnavailable = true
    const response = await GET(new NextRequest('http://localhost/api/cron/worker-heartbeat-check'))
    expect(response.status).toBe(500)
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'critical' }),
      'worker-heartbeat:blind',
      expect.any(Number)
    )
  })

  test('pages and fails the run when the roster read throws', async () => {
    mockHgetall.mockRejectedValueOnce(new Error('ECONNRESET'))
    const response = await GET(new NextRequest('http://localhost/api/cron/worker-heartbeat-check'))
    expect(response.status).toBe(500)
    expect(mockSendAlert.mock.calls[0][1]).toBe('worker-heartbeat:blind')
  })
})
