import {
  buildRegistrySourceFreshnessStatuses,
  buildSourceFreshnessStatuses,
  parseExpectedSourceWindows,
  RANKING_SOURCE_FUTURE_TOLERANCE_MS,
  RANKING_SOURCE_STALE_MS,
  summarizeSourceFreshness,
  type ExpectedSourceWindow,
  type SourceWindowFreshnessRow,
  type VisibleSourceWindow,
} from '../source-freshness'

const NOW = Date.parse('2026-07-18T12:00:00.000Z')

describe('leaderboard source freshness', () => {
  it('reports independent watermarks for multiple sources in one window', () => {
    const rows = [
      { source: 'fresh', source_as_of: '2026-07-18T11:00:00.000Z' },
      { source: 'stale', source_as_of: '2026-07-16T09:00:00.000Z' },
    ]

    expect(buildSourceFreshnessStatuses(rows, ['fresh', 'stale'], NOW)).toEqual([
      {
        source: 'fresh',
        updated_at: '2026-07-18T11:00:00.000Z',
        is_stale: false,
        age_seconds: 3600,
      },
      {
        source: 'stale',
        updated_at: '2026-07-16T09:00:00.000Z',
        is_stale: true,
        age_seconds: 51 * 3600,
      },
    ])
  })

  it('fails closed for an absent or invalid source instead of using compute time', () => {
    const summary = summarizeSourceFreshness(
      [{ source: 'invalid', source_as_of: 'not-a-timestamp' }],
      ['absent', 'invalid'],
      NOW
    )

    expect(summary).toEqual({
      asOf: null,
      isStale: true,
      ageSeconds: null,
      sources: [
        { source: 'absent', updated_at: null, is_stale: true, age_seconds: null },
        { source: 'invalid', updated_at: null, is_stale: true, age_seconds: null },
      ],
    })
  })

  it('fails closed for a future source watermark instead of treating it as fresh', () => {
    const future = new Date(NOW + 10 * 60 * 1000).toISOString()

    expect(
      buildSourceFreshnessStatuses([{ source: 'future', source_as_of: future }], ['future'], NOW)
    ).toEqual([{ source: 'future', updated_at: null, is_stale: true, age_seconds: null }])
  })

  it('uses the oldest source watermark for the page-level summary', () => {
    const summary = summarizeSourceFreshness(
      [
        { source: 'one', source_as_of: '2026-07-18T10:00:00.000Z' },
        { source: 'two', source_as_of: '2026-07-18T11:30:00.000Z' },
      ],
      ['one', 'two'],
      NOW
    )

    expect(summary.asOf).toBe('2026-07-18T10:00:00.000Z')
    expect(summary.ageSeconds).toBe(2 * 3600)
    expect(summary.isStale).toBe(false)
  })

  it('marks a source stale only after the ranking input cutoff', () => {
    const exactlyAtCutoff = new Date(NOW - RANKING_SOURCE_STALE_MS).toISOString()
    const justPastCutoff = new Date(NOW - RANKING_SOURCE_STALE_MS - 1).toISOString()

    expect(
      buildSourceFreshnessStatuses(
        [{ source: 'source', source_as_of: exactlyAtCutoff }],
        ['source'],
        NOW
      )[0]?.is_stale
    ).toBe(false)
    expect(
      buildSourceFreshnessStatuses(
        [{ source: 'source', source_as_of: justPastCutoff }],
        ['source'],
        NOW
      )[0]?.is_stale
    ).toBe(true)
  })
})

describe('registry-closed source-window freshness', () => {
  const expectedWindows: ExpectedSourceWindow[] = [
    {
      season_id: '7D',
      registry_slug: 'binance_futures',
      source: 'binance_futures',
      display_name: 'Binance Futures',
    },
    {
      season_id: '30D',
      registry_slug: 'binance_futures',
      source: 'binance_futures',
      display_name: 'Binance Futures',
    },
    {
      season_id: '90D',
      registry_slug: 'binance_futures',
      source: 'binance_futures',
      display_name: 'Binance Futures',
    },
  ]

  const visibleWindows: VisibleSourceWindow[] = [
    {
      season_id: '7D',
      registry_slug: 'binance_futures',
      source: 'binance_futures',
      display_name: 'Binance Futures',
      record_count: 100,
    },
    {
      season_id: '30D',
      registry_slug: 'binance_futures',
      source: 'binance_futures',
      display_name: 'Binance Futures',
      record_count: 90,
    },
    {
      season_id: '90D',
      registry_slug: 'binance_futures',
      source: 'binance_futures',
      display_name: 'Binance Futures',
      record_count: 80,
    },
  ]

  function watermarks(
    overrides: Partial<Record<'7D' | '30D' | '90D', string | null>> = {}
  ): SourceWindowFreshnessRow[] {
    return (['7D', '30D', '90D'] as const).map((season, index) => ({
      season_id: season,
      source: 'binance_futures',
      source_as_of: Object.hasOwn(overrides, season)
        ? (overrides[season] ?? null)
        : new Date(NOW - (index + 1) * 60 * 60 * 1000).toISOString(),
    }))
  }

  it('uses the oldest watermark and counts a shared alias once per window', () => {
    const duplicatePhysicalPromise: ExpectedSourceWindow = {
      ...expectedWindows[0],
      registry_slug: 'binance_futures_alt',
    }
    const duplicatePhysicalBoard: VisibleSourceWindow = {
      ...visibleWindows[0],
      registry_slug: 'binance_futures_alt',
    }

    expect(
      buildRegistrySourceFreshnessStatuses(
        [...expectedWindows, duplicatePhysicalPromise],
        [...visibleWindows, duplicatePhysicalBoard],
        watermarks(),
        NOW
      )
    ).toEqual([
      {
        source: 'binance_futures',
        display_name: 'Binance Futures',
        updated_at: '2026-07-18T09:00:00.000Z',
        record_count: 270,
        issues: [],
      },
    ])
  })

  it.each([
    ['missing', watermarks().filter((row) => row.season_id !== '30D'), 'missing'],
    ['null', watermarks({ '30D': null }), 'invalid'],
    ['invalid', watermarks({ '30D': 'not-a-timestamp' }), 'invalid'],
    [
      'non-text',
      watermarks().map((row) => (row.season_id === '30D' ? { ...row, source_as_of: 123 } : row)),
      'invalid',
    ],
    [
      'future',
      watermarks({
        '30D': new Date(NOW + RANKING_SOURCE_FUTURE_TOLERANCE_MS + 1).toISOString(),
      }),
      'future',
    ],
    ['duplicate', [...watermarks(), watermarks()[1]], 'duplicate'],
  ] as const)('fails closed for a %s expected window watermark', (_case, rows, reason) => {
    expect(
      buildRegistrySourceFreshnessStatuses(expectedWindows, visibleWindows, rows, NOW)
    ).toEqual([
      expect.objectContaining({
        source: 'binance_futures',
        updated_at: null,
        issues: [{ season_id: '30D', reason }],
      }),
    ])
  })

  it('accepts exactly five minutes of clock skew and normalizes the watermark', () => {
    const boundary = new Date(NOW + RANKING_SOURCE_FUTURE_TOLERANCE_MS).toISOString()
    const result = buildRegistrySourceFreshnessStatuses(
      [expectedWindows[0]],
      [visibleWindows[0]],
      watermarks({ '7D': boundary }),
      NOW
    )

    expect(result[0]).toMatchObject({
      updated_at: boundary,
      issues: [],
    })
  })

  it('ignores retired or otherwise non-expected watermark rows', () => {
    const result = buildRegistrySourceFreshnessStatuses(
      expectedWindows,
      visibleWindows,
      [
        ...watermarks(),
        {
          season_id: '90D',
          source: 'retired_source',
          source_as_of: '2020-01-01T00:00:00.000Z',
        },
      ],
      NOW
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.source).toBe('binance_futures')
    expect(result[0]?.issues).toEqual([])
  })

  it('keeps a registry promise observable when its current count row disappears', () => {
    const result = buildRegistrySourceFreshnessStatuses(
      expectedWindows,
      visibleWindows.filter((window) => window.season_id !== '30D'),
      watermarks(),
      NOW
    )

    expect(result).toEqual([
      expect.objectContaining({
        source: 'binance_futures',
        updated_at: null,
        record_count: 180,
        issues: [
          {
            season_id: '30D',
            reason: 'not_visible',
            registry_slug: 'binance_futures',
          },
        ],
      }),
    ])
  })

  it('reports zero records instead of dropping an entirely non-visible registry source', () => {
    const result = buildRegistrySourceFreshnessStatuses(expectedWindows, [], watermarks(), NOW)

    expect(result[0]).toMatchObject({
      source: 'binance_futures',
      updated_at: null,
      record_count: 0,
    })
    expect(result[0]?.issues.filter((issue) => issue.reason === 'not_visible')).toHaveLength(3)
  })

  it('rejects empty, conflicting, extra, duplicate, or inconsistent authorities', () => {
    expect(() => buildRegistrySourceFreshnessStatuses([], [], [], NOW)).toThrow(
      'returned no windows'
    )
    expect(() =>
      buildRegistrySourceFreshnessStatuses(
        [expectedWindows[0], { ...expectedWindows[1], display_name: 'Conflicting Exchange' }],
        visibleWindows,
        watermarks(),
        NOW
      )
    ).toThrow('conflicting display names')
    expect(() =>
      buildRegistrySourceFreshnessStatuses(
        expectedWindows,
        [
          ...visibleWindows,
          {
            ...visibleWindows[0],
            registry_slug: 'outside_registry',
          },
        ],
        watermarks(),
        NOW
      )
    ).toThrow('outside the freshness registry authority')
    expect(() =>
      buildRegistrySourceFreshnessStatuses(
        expectedWindows,
        [...visibleWindows, visibleWindows[0]],
        watermarks(),
        NOW
      )
    ).toThrow('duplicate registry window')
  })

  it('rejects conflicting counts across physical boards sharing one public alias', () => {
    const expectedAlt = {
      ...expectedWindows[0],
      registry_slug: 'binance_futures_alt',
    }
    const visibleAlt = {
      ...visibleWindows[0],
      registry_slug: 'binance_futures_alt',
      record_count: 99,
    }

    expect(() =>
      buildRegistrySourceFreshnessStatuses(
        [...expectedWindows, expectedAlt],
        [...visibleWindows, visibleAlt],
        watermarks(),
        NOW
      )
    ).toThrow('conflicting record counts')
  })
})

describe('freshness expected-source RPC parser', () => {
  const row = {
    registry_slug: 'binance_futures',
    filter_source: 'binance_futures',
    exchange_name: 'Binance',
    season_id: '90D',
  }

  it('maps the strict database boundary into expected source windows', () => {
    expect(parseExpectedSourceWindows([row])).toEqual([
      {
        registry_slug: 'binance_futures',
        source: 'binance_futures',
        display_name: 'Binance',
        season_id: '90D',
      },
    ])
  })

  it.each([
    ['empty', []],
    ['non-array', {}],
    ['bad season', [{ ...row, season_id: '24H' }]],
    ['trimmed identity', [{ ...row, filter_source: ' binance_futures' }]],
    ['null sentinel', [{ ...row, filter_source: 'null' }]],
    ['duplicate physical window', [row, row]],
    [
      'inconsistent registry identity',
      [row, { ...row, season_id: '30D', filter_source: 'different_alias' }],
    ],
  ])('rejects %s authority data', (_case, data) => {
    expect(() => parseExpectedSourceWindows(data)).toThrow()
  })
})
