import {
  buildPlatformHealth,
  classifyPlatformHealth,
  type PlatformHealth,
} from '../platform-health'

describe('buildPlatformHealth', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z')

  it('uses registry RPC rows as the complete active-source authority', () => {
    const result = buildPlatformHealth({
      now,
      freshnessRows: [
        { source: 'active_fresh', latest: '2026-07-18T11:00:00.000Z' },
        { source: 'active_without_snapshot', latest: null },
        { source: 'okx_web3_solana', latest: '2026-07-18T04:00:00.000Z' },
      ],
      logs: [],
    })

    expect(result.map((row) => row.platform)).toEqual([
      'active_fresh',
      'active_without_snapshot',
      'okx_web3_solana',
    ])
    expect(result.find((row) => row.platform === 'active_without_snapshot')).toMatchObject({
      lastUpdate: null,
      ageHours: null,
      status: 'critical',
    })
    expect(result.find((row) => row.platform === 'okx_web3_solana')?.status).toBe('warning')
    expect(result.some((row) => row.platform === 'coinex')).toBe(false)
    expect(result.some((row) => row.platform === 'okx_web3')).toBe(false)
  })

  it('aggregates matching logs without merging source identities', () => {
    const result = buildPlatformHealth({
      now,
      freshnessRows: [{ source: 'bybit', latest: '2026-07-18T10:00:00.000Z' }],
      logs: [
        { job_name: 'fetch-bybit-7d', records_processed: 10 },
        { job_name: 'fetch-bybit-30d', records_processed: 20 },
        { job_name: 'fetch-binance-7d', records_processed: 999 },
      ],
      getDisplayName: (platform) => platform.toUpperCase(),
    })

    expect(result).toEqual([
      {
        platform: 'bybit',
        displayName: 'BYBIT',
        lastUpdate: '2026-07-18T10:00:00.000Z',
        ageHours: 2,
        currentCount: 0,
        avgCount: 15,
        countRatio: null,
        status: 'healthy',
      },
    ])
  })

  it.each([
    ['empty result', []],
    ['blank source', [{ source: '  ', latest: null }]],
    [
      'duplicate source',
      [
        { source: 'bybit', latest: '2026-07-18T10:00:00.000Z' },
        { source: 'bybit', latest: '2026-07-18T11:00:00.000Z' },
      ],
    ],
    ['invalid timestamp', [{ source: 'bybit', latest: 'not-a-date' }]],
    ['future timestamp', [{ source: 'bybit', latest: '2026-07-18T12:06:00.000Z' }]],
  ])('rejects malformed registry membership: %s', (_case, freshnessRows) => {
    expect(() =>
      buildPlatformHealth({
        now,
        freshnessRows,
        logs: [],
      })
    ).toThrow()
  })

  it('allows small clock skew without hiding a missing snapshot', () => {
    expect(
      buildPlatformHealth({
        now,
        freshnessRows: [
          { source: 'clock_skew', latest: '2026-07-18T12:04:00.000Z' },
          { source: 'never_fetched', latest: null },
        ],
        logs: [],
      })
    ).toEqual([
      expect.objectContaining({
        platform: 'clock_skew',
        status: 'healthy',
      }),
      expect.objectContaining({
        platform: 'never_fetched',
        lastUpdate: null,
        ageHours: null,
        status: 'critical',
      }),
    ])
  })
})

describe('classifyPlatformHealth', () => {
  function platform(
    name: string,
    status: PlatformHealth['status'],
    lastUpdate: string | null = '2026-07-18T10:00:00.000Z'
  ): PlatformHealth {
    return {
      platform: name,
      displayName: name,
      lastUpdate,
      ageHours: lastUpdate ? 2 : null,
      currentCount: 0,
      avgCount: null,
      countRatio: null,
      status,
    }
  }

  it('treats an active source that never initialized as critical', () => {
    expect(
      classifyPlatformHealth([platform('healthy', 'healthy'), platform('never', 'critical', null)])
    ).toBe('critical')
  })

  it('treats one stale source in a broad healthy fleet as degraded, not healthy', () => {
    const platforms = Array.from({ length: 33 }, (_, index) =>
      platform(`healthy_${index}`, 'healthy')
    )
    platforms.push(platform('stale', 'critical'))
    expect(classifyPlatformHealth(platforms)).toBe('degraded')
  })

  it('reserves critical for a broad outage and degraded for broad warnings', () => {
    expect(
      classifyPlatformHealth([
        platform('critical_1', 'critical'),
        platform('critical_2', 'critical'),
        platform('healthy_1', 'healthy'),
        platform('healthy_2', 'healthy'),
      ])
    ).toBe('critical')
    expect(
      classifyPlatformHealth([
        platform('warning_1', 'warning'),
        platform('warning_2', 'warning'),
        platform('healthy_1', 'healthy'),
        platform('healthy_2', 'healthy'),
      ])
    ).toBe('degraded')
  })
})
