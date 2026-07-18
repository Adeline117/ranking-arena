import {
  buildSourceFreshnessStatuses,
  RANKING_SOURCE_STALE_MS,
  summarizeSourceFreshness,
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
