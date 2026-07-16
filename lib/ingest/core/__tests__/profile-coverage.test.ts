import type { ParsedProfile } from '../types'
import { findIncompleteProfileWindow, IncompleteProfileWindowError } from '../profile-coverage'

function profile(complete: boolean, reason?: string): Pick<ParsedProfile, 'stats'> {
  return {
    stats: [
      {
        timeframe: 30,
        asOf: '2026-07-15T00:00:00.000Z',
        roi: null,
        pnl: null,
        sharpe: null,
        mdd: null,
        winRate: null,
        winPositions: null,
        totalPositions: null,
        copierPnl: null,
        copierCount: null,
        aum: null,
        volume: null,
        profitShareRate: null,
        holdingDurationAvgHours: null,
        tradingPreferences: null,
        extras: {
          profile_window_metrics_complete: complete,
          profile_window_metrics_incomplete_reason: reason,
        },
      },
    ],
  }
}

describe('profile window coverage contract', () => {
  it('returns null for a proven window', () => {
    expect(findIncompleteProfileWindow(profile(true))).toBeNull()
  })

  it('returns the timeframe and generic failure reason', () => {
    expect(findIncompleteProfileWindow(profile(false, 'window_prefix_not_covered'))).toEqual({
      timeframe: 30,
      reason: 'window_prefix_not_covered',
    })
  })

  it('keeps a typed error for worker retry accounting', () => {
    expect(new IncompleteProfileWindowError(90, 'page_cap')).toMatchObject({
      name: 'IncompleteProfileWindowError',
      timeframe: 90,
      reason: 'page_cap',
      message: 'incomplete profile window 90d: page_cap',
    })
  })
})
