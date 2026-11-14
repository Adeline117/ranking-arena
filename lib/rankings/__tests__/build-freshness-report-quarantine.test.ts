jest.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: jest.fn() }))

import { applySourceQuarantine } from '../build-freshness-report'
import type { PlatformFreshnessStatus } from '../freshness-report'

const NOW = Date.parse('2026-11-13T12:00:00.000Z')

function platform(
  name: string,
  status: PlatformFreshnessStatus['status']
): PlatformFreshnessStatus {
  return {
    platform: name,
    displayName: name.toUpperCase(),
    lastUpdate: '2026-11-13T11:00:00.000Z',
    ageMs: 3_600_000,
    ageHours: 1,
    status,
    recordCount: 10,
  }
}

describe('applySourceQuarantine', () => {
  it('lists a source that is isolated from every season instead of dropping it', () => {
    const result = applySourceQuarantine(
      [platform('binance_futures', 'fresh')],
      [
        {
          season_id: '90D',
          filter_source: 'bybit',
          reasons: ['stale'],
          first_isolated_at: '2026-11-12T00:00:00.000Z',
          isolated_at: '2026-11-13T10:00:00.000Z',
        },
        {
          season_id: '30D',
          filter_source: 'bybit',
          reasons: ['latest_attempt_failed'],
          first_isolated_at: '2026-11-13T08:00:00.000Z',
          isolated_at: '2026-11-13T10:00:00.000Z',
        },
      ],
      [
        {
          season_id: '90D',
          source: 'bybit',
          source_as_of: '2026-11-11T12:00:00.000Z',
          recorded_at: '2026-11-11T12:05:00.000Z',
          score_cohort_id: 'c',
          published_rank_count: 3,
        },
      ],
      NOW
    )
    expect(result.map((entry) => [entry.platform, entry.status])).toEqual([
      ['binance_futures', 'fresh'],
      ['bybit', 'quarantined'],
    ])
    expect(result[1]).toMatchObject({
      lastUpdate: '2026-11-11T12:00:00.000Z',
      ageHours: 48,
      recordCount: 0,
      quarantine: [
        {
          season: '30D',
          reasons: ['latest_attempt_failed'],
          since: '2026-11-13T08:00:00.000Z',
          lastConfirmedAt: '2026-11-13T10:00:00.000Z',
        },
        {
          season: '90D',
          reasons: ['stale'],
          since: '2026-11-12T00:00:00.000Z',
          lastConfirmedAt: '2026-11-13T10:00:00.000Z',
        },
      ],
    })
  })

  it('marks a still-expected fresh source quarantined but never hides a worse status', () => {
    const isolation = (source: string) => ({
      season_id: '7D',
      filter_source: source,
      reasons: ['missing'],
      first_isolated_at: '2026-11-13T00:00:00.000Z',
      isolated_at: '2026-11-13T10:00:00.000Z',
    })
    const result = applySourceQuarantine(
      [platform('okx_futures', 'fresh'), platform('hyperliquid', 'critical')],
      [isolation('okx_futures'), isolation('hyperliquid')],
      [],
      NOW
    )
    expect(result.map((entry) => entry.status)).toEqual(['quarantined', 'critical'])
    expect(result.every((entry) => entry.quarantine?.[0]?.season === '7D')).toBe(true)
  })

  it('leaves the report unchanged when nothing is isolated', () => {
    const platforms = [platform('binance_futures', 'fresh')]
    expect(applySourceQuarantine(platforms, [], [], NOW)).toEqual(platforms)
  })
})
