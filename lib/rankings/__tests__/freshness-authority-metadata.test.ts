import { deriveFreshnessAuthorityMetadata } from '../build-freshness-report'
import type { ExpectedSourceWindow, VisibleSourceWindow } from '../source-freshness'

const NOW = Date.parse('2026-08-03T18:00:00.000Z')
const PUBLISHED_AT = '2026-08-03T16:00:00.000Z'

function expected(
  season_id: ExpectedSourceWindow['season_id'],
  registry_slug: string,
  source: string
): ExpectedSourceWindow {
  return { season_id, registry_slug, source, display_name: source.toUpperCase() }
}

function visible(window: ExpectedSourceWindow): VisibleSourceWindow {
  return { ...window, record_count: 10 }
}

function publication(source: string, cohort = 'cohort-1', recordedAt = PUBLISHED_AT) {
  return {
    season_id: '90D',
    source,
    source_as_of: '2026-08-03T15:00:00.000Z',
    recorded_at: recordedAt,
    score_cohort_id: cohort,
    published_rank_count: 10,
  }
}

describe('freshness authority public metadata', () => {
  const expectedWindows = [
    expected('7D', 'binance_futures', 'binance'),
    expected('90D', 'binance_futures', 'binance'),
    expected('90D', 'bybit_futures', 'bybit'),
  ]

  it('counts physical boards once and proves a complete current 90D publication', () => {
    expect(
      deriveFreshnessAuthorityMetadata(
        expectedWindows,
        expectedWindows.map(visible),
        [publication('binance'), publication('bybit')],
        NOW
      )
    ).toEqual({
      coverage: { expectedSourceBoards: 2, visibleSourceBoards: 2 },
      latestSuccessfulPublication: { season: '90D', publishedAt: PUBLISHED_AT },
    })
  })

  it.each([
    ['a missing expected source', [publication('binance')]],
    ['mixed publication cohorts', [publication('binance'), publication('bybit', 'cohort-2')]],
    [
      'mixed publication timestamps',
      [publication('binance'), publication('bybit', 'cohort-1', '2026-08-03T17:00:00.000Z')],
    ],
  ])('returns unknown publication evidence for %s', (_reason, rows) => {
    const metadata = deriveFreshnessAuthorityMetadata(
      expectedWindows,
      expectedWindows.slice(0, 2).map(visible),
      rows,
      NOW
    )

    expect(metadata.coverage).toEqual({ expectedSourceBoards: 2, visibleSourceBoards: 1 })
    expect(metadata.latestSuccessfulPublication).toBeNull()
  })
})
