/** @jest-environment node */

const mockSendAlert = jest.fn()
const mockHdel = jest.fn()
const mockHgetall = jest.fn()

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    const result = await handler(request, {})
    return Response.json({ ok: true, ...result })
  },
}))

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: async () => ({ hdel: mockHdel, hgetall: mockHgetall }),
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
