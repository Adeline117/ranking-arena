import {
  filterPublicNonRankingActivities,
  hasPublicNonRankingActivityTypes,
  isPublicNonRankingActivity,
  noStorePublicActivity,
  PUBLIC_ACTIVITY_CACHE_EPOCH,
  PUBLIC_ACTIVITY_VISIBILITY_REASON,
  PUBLIC_NON_RANKING_ACTIVITY_TYPES,
  RANKING_ACTIVITY_TYPES,
  unavailablePublicActivityFeed,
} from '../public-activity-policy'

describe('public activity publication policy', () => {
  it('fails every ranking-derived activity type closed', () => {
    expect(RANKING_ACTIVITY_TYPES).toEqual([
      'rank_up',
      'entered_top10',
      'roi_milestone',
      'score_high',
      'large_profit',
    ])

    for (const activity_type of RANKING_ACTIVITY_TYPES) {
      expect(
        isPublicNonRankingActivity({
          activity_type,
          activity_text: 'raw historical ranking claim',
          metric_value: 999,
        })
      ).toBe(false)
    }
  })

  it('admits no legacy free-form kind until event-time receipts exist', () => {
    expect(PUBLIC_NON_RANKING_ACTIVITY_TYPES).toEqual([])
    expect(hasPublicNonRankingActivityTypes()).toBe(false)
    expect(
      PUBLIC_NON_RANKING_ACTIVITY_TYPES.every(
        (activity_type) => !RANKING_ACTIVITY_TYPES.includes(activity_type as never)
      )
    ).toBe(true)
    expect(isPublicNonRankingActivity({ activity_type: 'win_streak' })).toBe(false)
    expect(isPublicNonRankingActivity({ activity_type: 'large_trade' })).toBe(false)
    expect(isPublicNonRankingActivity({ activity_type: 'new_unreviewed_type' })).toBe(false)
    expect(isPublicNonRankingActivity({})).toBe(false)
  })

  it('filters forged query/cache payload rows at the release boundary', () => {
    const rows = [
      { id: 'safe', activity_type: 'win_streak' },
      { id: 'raw-roi', activity_type: 'roi_milestone' },
      { id: 'unknown', activity_type: 'future_metric_event' },
      { id: 'safe-trade', activity_type: 'large_trade' },
    ]

    expect(filterPublicNonRankingActivities(rows)).toEqual([])
  })

  it('returns an explicit unavailable state without querying historical rows', () => {
    expect(unavailablePublicActivityFeed(7)).toEqual({
      activities: [],
      pagination: { limit: 7, hasMore: false, nextCursor: null },
      activity_visibility: 'unavailable',
      activity_visibility_reason: PUBLIC_ACTIVITY_VISIBILITY_REASON,
    })
  })

  it('sets a cache-busting no-store response contract', () => {
    const response = noStorePublicActivity(new Response('ok'))

    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Pragma')).toBe('no-cache')
    expect(PUBLIC_ACTIVITY_CACHE_EPOCH).toBe('event-receipt-required-v2')
  })
})
