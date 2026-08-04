import {
  readPublicHealthSnapshot,
  readPublicPlatformHealthSnapshot,
} from './status-client-contract'

const NOW = Date.parse('2026-08-03T18:00:00.000Z')

function healthPayload(overrides: Record<string, unknown> = {}) {
  return {
    status: 'degraded',
    timestamp: '2026-08-03T17:59:00.000Z',
    version: '0.1.0',
    commit: 'abc123',
    uptime: 3600,
    responseTimeMs: 83,
    checks: {
      api: { status: 'pass', latency: 1, message: 'Responding' },
      database: { status: 'pass', latency: 80 },
      redis: { status: 'skip', latency: 2, message: 'Not configured' },
    },
    _detail: '/api/health/detailed',
    ...overrides,
  }
}

function platformPayload(overrides: Record<string, unknown> = {}) {
  return {
    platforms: [
      {
        platform: 'binance_futures',
        status: 'healthy',
        last_success_at: '2026-08-03T17:58:00+00:00',
        error_count: 0,
      },
    ],
    freshness: {
      binance_futures: '2026-08-03T17:58:30+00:00',
    },
    ...overrides,
  }
}

describe('public status client contracts', () => {
  it('accepts and canonicalizes the exact health authority payload', () => {
    expect(readPublicHealthSnapshot(healthPayload(), NOW)).toEqual({
      status: 'degraded',
      timestamp: '2026-08-03T17:59:00.000Z',
      version: '0.1.0',
      commit: 'abc123',
      uptime: 3600,
      responseTimeMs: 83,
      checks: {
        api: { status: 'pass', latency: 1, message: 'Responding' },
        database: { status: 'pass', latency: 80 },
        redis: { status: 'skip', latency: 2, message: 'Not configured' },
      },
    })
  })

  it.each([
    ['an extra root field', healthPayload({ internal: 'secret' })],
    ['a future timestamp', healthPayload({ timestamp: '2026-08-03T18:10:00.000Z' })],
    ['a malformed check', healthPayload({ checks: { api: { status: 'green' } } })],
    ['a negative latency', healthPayload({ checks: { api: { status: 'pass', latency: -1 } } })],
    ['a noncanonical detail route', healthPayload({ _detail: '/admin/health' })],
    ['an empty check partition', healthPayload({ checks: {} })],
  ])('rejects %s', (_name, payload) => {
    expect(readPublicHealthSnapshot(payload, NOW)).toBeNull()
  })

  it('accepts exact platform rows and freshness with timezone offsets', () => {
    expect(readPublicPlatformHealthSnapshot(platformPayload(), NOW)).toEqual({
      platforms: [
        {
          platform: 'binance_futures',
          status: 'healthy',
          lastSuccessAt: '2026-08-03T17:58:00.000Z',
          errorCount: 0,
        },
      ],
      freshness: { binance_futures: '2026-08-03T17:58:30.000Z' },
    })
  })

  it.each([
    [
      'an extra platform row field',
      platformPayload({
        platforms: [{ ...platformPayload().platforms[0], last_error: 'private' }],
      }),
    ],
    [
      'a duplicate platform',
      platformPayload({
        platforms: [platformPayload().platforms[0], platformPayload().platforms[0]],
      }),
    ],
    [
      'a negative error count',
      platformPayload({ platforms: [{ ...platformPayload().platforms[0], error_count: -1 }] }),
    ],
    [
      'a malformed freshness value',
      platformPayload({ freshness: { binance_futures: 'recently' } }),
    ],
    [
      'a future freshness value',
      platformPayload({ freshness: { binance_futures: '2026-08-03T18:10:00Z' } }),
    ],
    ['an extra root field', platformPayload({ cache_key: 'internal' })],
  ])('rejects %s', (_name, payload) => {
    expect(readPublicPlatformHealthSnapshot(payload, NOW)).toBeNull()
  })
})
