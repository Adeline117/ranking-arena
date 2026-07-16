import { PROFILE_SERIES_MAX_TAIL_AGE_MS, validateRequiredSeriesTails } from '../profile-quality'
import type { ParseCtx, ParsedProfile, Timeframe } from '../types'

const REFERENCE = '2026-07-16T16:00:00.000Z'
const ctx: ParseCtx = {
  sourceSlug: 'test',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: REFERENCE,
  meta: {},
}

function profile(
  timeframe: Timeframe,
  pnlTimes: string[],
  roiTimes: string[] = pnlTimes
): ParsedProfile {
  return {
    nickname: null,
    avatarUrlOrigin: null,
    stats: [
      {
        timeframe,
        asOf: REFERENCE,
        roi: 1,
        pnl: 1,
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
        extras: {},
      },
    ],
    series: [
      { timeframe, metric: 'pnl', points: pnlTimes.map((ts, value) => ({ ts, value })) },
      { timeframe, metric: 'roi', points: roiTimes.map((ts, value) => ({ ts, value })) },
    ],
  }
}

const validate = (candidate: ParsedProfile, timeframe: Timeframe = 30, parseCtx = ctx) =>
  validateRequiredSeriesTails(candidate, parseCtx, timeframe, {
    requiredMetrics: ['pnl', 'roi'],
  })

describe('validateRequiredSeriesTails', () => {
  it.each([7, 30, 90] as const)('accepts an exact 48h tail for %sd', (timeframe) => {
    const exactBoundary = new Date(
      Date.parse(REFERENCE) - PROFILE_SERIES_MAX_TAIL_AGE_MS
    ).toISOString()
    expect(validate(profile(timeframe, [exactBoundary]), timeframe)).toEqual([])
  })

  it('rejects a tail one millisecond beyond 48h', () => {
    const stale = new Date(Date.parse(REFERENCE) - PROFILE_SERIES_MAX_TAIL_AGE_MS - 1).toISOString()
    expect(validate(profile(30, [stale]))[0]).toMatchObject({
      reason: 'profile_series_tail_stale',
      payload: { blocking_reasons: ['profile_series_tail_stale'] },
    })
  })

  it('uses the maximum timestamp for unsorted points', () => {
    expect(
      validate(
        profile(30, [
          '2026-07-16T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z',
          '2026-07-15T00:00:00.000Z',
        ])
      )
    ).toEqual([])
  })

  it('rejects the whole surface when one required metric is stale', () => {
    const rejects = validate(
      profile(30, ['2026-07-16T00:00:00.000Z'], ['2026-07-01T00:00:00.000Z'])
    )
    expect(rejects[0].reason).toBe('profile_series_tail_stale')
    expect(rejects[0].payload).toMatchObject({
      metrics: {
        pnl: { tail_at: '2026-07-16T00:00:00.000Z' },
        roi: { tail_at: '2026-07-01T00:00:00.000Z' },
      },
    })
  })

  it('rejects missing and malformed required series', () => {
    const missing = profile(30, ['2026-07-16T00:00:00.000Z'])
    missing.series = missing.series.filter((series) => series.metric !== 'roi')
    expect(validate(missing)[0].reason).toBe('profile_series_tail_missing')

    const malformed = profile(30, ['not-an-iso-timestamp'])
    expect(malformed.series[0].points[0]).toBeDefined()
    expect(validate(malformed)[0].payload).toMatchObject({
      blocking_reasons: expect.arrayContaining([
        'profile_series_tail_missing',
        'profile_series_point_invalid',
      ]),
    })
  })

  it('rejects a detached prefix even when the tail is fresh', () => {
    const rejects = validate(profile(30, ['2025-10-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z']))
    expect(rejects[0].reason).toBe('profile_series_point_outside_window')
  })

  it('allows a daily bucket within 24h ahead but rejects anything later', () => {
    const within = '2026-07-17T16:00:00.000Z'
    expect(validate(profile(30, [within]))).toEqual([])
    const beyond = '2026-07-17T16:00:00.001Z'
    expect(validate(profile(30, [beyond]))[0].reason).toBe('profile_series_tail_future')
  })

  it('rejects a parsed/requested timeframe mismatch and invalid reference', () => {
    expect(validate(profile(7, ['2026-07-16T00:00:00.000Z']), 30)[0].reason).toBe(
      'profile_timeframe_mismatch'
    )
    expect(
      validate(profile(30, ['2026-07-16T00:00:00.000Z']), 30, { ...ctx, scrapedAt: 'bad' })[0]
        .reason
    ).toBe('profile_reference_time_invalid')
  })
})
