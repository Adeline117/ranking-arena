import { summarizeInitialTraderFreshness } from '../getInitialTraders'

const NOW = Date.parse('2026-07-18T12:00:00.000Z')
const GENERATION = '2026-07-18T11:59:00.000Z'

describe('SSR leaderboard source freshness', () => {
  it('uses every live count-cache source, not only sources visible on the first page', () => {
    const summary = summarizeInitialTraderFreshness({
      countRows: [
        { source: '_all_gt0', total_count: 2, updated_at: GENERATION },
        { source: 'fresh_gt0', total_count: 1, updated_at: GENERATION },
        { source: 'stale_gt0', total_count: 1, updated_at: GENERATION },
      ],
      watermarkRows: [
        { source: 'fresh', source_as_of: '2026-07-18T11:00:00.000Z' },
        { source: 'stale', source_as_of: '2026-07-16T09:00:00.000Z' },
      ],
      observedSources: ['fresh'],
      nowMs: NOW,
    })

    expect(summary.asOf).toBe('2026-07-16T09:00:00.000Z')
    expect(summary.isStale).toBe(true)
    expect(summary.sources.map((source) => source.source)).toEqual(['fresh', 'stale'])
  })

  it('fails closed when only rendered sources are known after count-cache loss', () => {
    const summary = summarizeInitialTraderFreshness({
      countRows: [],
      watermarkRows: [
        { source: 'rendered', source_as_of: '2026-07-18T10:00:00.000Z' },
        { source: 'retired', source_as_of: '2026-07-10T10:00:00.000Z' },
      ],
      observedSources: ['rendered'],
      nowMs: NOW,
    })

    expect(summary.asOf).toBe('2026-07-18T10:00:00.000Z')
    expect(summary.isStale).toBe(true)
    expect(summary.sources.map((source) => source.source)).toEqual(['rendered'])
  })
})
