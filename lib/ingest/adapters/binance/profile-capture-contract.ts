/**
 * Tier-B profile capture contracts for binance_futures and binance_spot
 * (docs/PROFILE_CAPTURE_EVIDENCE.md).
 *
 * getProfile fetches detail + performance + two chart series + coin
 * preference per timeframe and stores them as ONE page whose url is the
 * performance request (portfolioId + timeRange) and whose payload is the
 * wrapper parseBinanceProfile reads ({ detail, performance, ... }).
 *
 * Attested metrics, checked against public performance responses for 7D/30D/
 * 90D (2026-11-16 probe):
 *   - mdd: performance.data.mdd, already percent, non-negative, differs per
 *     window on both boards. The futures board's data.list[].mdd is a real
 *     value too, not a placeholder (lifted as headlineMdd, see parsers.ts;
 *     the board fixture carries 0, 0.0116843, 13.556168, 38.776595 ...).
 *     The window drawdown is computed on the daily equity (ROI) curve, so 0
 *     means daily equity never fell in the window, intraday losses included
 *     (fixtures performance-7 / chart-roi-7: mdd 11.839176 equals the
 *     drawdown of the daily ROI points, 11.8392%).
 *   - total_positions (futures): performance.data.totalOrder, per window;
 *     sometimes null upstream, which the parser keeps as an honest absence.
 * Deliberately NOT attested:
 *   - spot winRate: identical for 7D/30D/90D and equal to detail winDays /
 *     joinDays (83/914 = 9.08 %), i.e. a lifetime win-day ratio, not a
 *     window win rate. Attesting it as a 7D/30D/90D value would mislabel it.
 *     The parser stores it as extras.lifetime_win_rate and leaves the window
 *     win rate empty. The public eligibility policy requires a window win
 *     rate (arena.leaderboard_rank_row_is_public_eligible), so binance_spot
 *     stays off the ranking until Binance publishes one.
 *   - sharpRatio: identical across windows on both boards (lifetime value).
 *   - roi/pnl/win rate (futures): the Tier-A board already supplies them.
 *
 * The endpoint URLs live here (not in index.ts) so the contract and the
 * request builder cannot drift apart; this module imports types only, so the
 * contract registry can load it without the worker-only adapter.
 */

import type { ProfileCaptureContract } from '../../profile-capture/contract'

const ORIGIN = 'https://www.binance.com'
const PERFORMANCE_PATH = {
  futures: '/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance',
  spot: '/bapi/futures/v1/public/future/spot-copy-trade/lead-portfolio/performance',
} as const

/** The performance URL getProfile requests (and records as the page url). */
export const BINANCE_PROFILE_PERFORMANCE_URLS = {
  futures: `${ORIGIN}${PERFORMANCE_PATH.futures}`,
  spot: `${ORIGIN}${PERFORMANCE_PATH.spot}`,
} as const

function performanceEndpoint(board: keyof typeof PERFORMANCE_PATH) {
  return {
    id: 'performance',
    origin: ORIGIN,
    pathname: PERFORMANCE_PATH[board],
    queryAllowlist: ['portfolioId', 'timeRange'],
    required: true,
  } as const
}

export const BINANCE_FUTURES_PROFILE_CAPTURE: ProfileCaptureContract = {
  document: 'arena.profile-capture-contract@1',
  captureContract: 'binance_futures-profile-capture@1',
  sourceSlug: 'binance_futures',
  timeframes: [7, 30, 90],
  endpoints: [performanceEndpoint('futures')],
  metrics: {
    mdd: { endpoint: 'performance', path: ['performance', 'data', 'mdd'], transform: 'identity' },
    total_positions: {
      endpoint: 'performance',
      path: ['performance', 'data', 'totalOrder'],
      transform: 'identity',
    },
  },
}

export const BINANCE_SPOT_PROFILE_CAPTURE: ProfileCaptureContract = {
  document: 'arena.profile-capture-contract@1',
  captureContract: 'binance_spot-profile-capture@1',
  sourceSlug: 'binance_spot',
  timeframes: [7, 30, 90],
  endpoints: [performanceEndpoint('spot')],
  metrics: {
    mdd: { endpoint: 'performance', path: ['performance', 'data', 'mdd'], transform: 'identity' },
  },
}
