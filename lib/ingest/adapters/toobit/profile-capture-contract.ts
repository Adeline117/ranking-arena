/**
 * toobit_futures Tier-B profile capture contract (docs/PROFILE_CAPTURE_EVIDENCE.md).
 *
 * The board (leaders-new) carries ROI, PnL, win rate and Sharpe but no
 * drawdown; the profile radar (get-leader-radar-chart?leaderUserId&type) is
 * the exchange's own per-window maximum drawdown, a decimal fraction
 * (0.9587 = 95.87 %). Public probe 2026-11-17: present for 7/30/90, distinct
 * per window, echoed `type` equals the requested window.
 *
 * Not attested:
 * - trade count: leader-detail.tradeCount is the lifetime count (identical
 *   for every window), not the window's trade count; no window trade count
 *   is exposed publicly.
 * - ROI / PnL / win rate: publication reads them from the board headline.
 *
 * getProfile records the radar request as the page url, so the request
 * projection binds the trader (leaderUserId) and the window (type).
 *
 * Imports types only, so the contract registry can load it without the
 * worker-only adapter (and without an import cycle).
 */

import type { ProfileCaptureContract } from '../../profile-capture/contract'

export const TOOBIT_FUTURES_PROFILE_CAPTURE: ProfileCaptureContract = {
  document: 'arena.profile-capture-contract@1',
  captureContract: 'toobit_futures-profile-capture@1',
  sourceSlug: 'toobit_futures',
  timeframes: [7, 30, 90],
  endpoints: [
    {
      id: 'radar',
      origin: 'https://bapi.toobit.com',
      pathname: '/bapi/v1/copy-trading/get-leader-radar-chart',
      queryAllowlist: ['leaderUserId', 'type'],
      required: true,
    },
  ],
  metrics: {
    mdd: {
      endpoint: 'radar',
      path: ['radar', 'data', 'leaderMaximumDrawdown'],
      transform: 'fraction_to_percent',
    },
  },
}
