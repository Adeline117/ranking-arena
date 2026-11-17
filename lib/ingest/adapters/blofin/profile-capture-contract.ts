/**
 * Blofin futures Tier-B profile capture contract (docs/PROFILE_CAPTURE_EVIDENCE.md).
 *
 * getProfile returns ONE composite page per timeframe: the four unsigned POST
 * responses {info, indicators, symbolPerf, performance} plus the timeframe,
 * keyed by the stat/indicators request (uid + stat_period recorded as the URL
 * query, so the request projection binds the trader and the period).
 * parseBlofinProfile builds the timeframe's only stats block from
 * `indicators.data`.
 *
 * Attested metrics, verified per stat_period by a public probe (2026-11-17,
 * D7/D30/D90 of one trader):
 *   - win_rate        indicators.data.win_ratio_all (fraction; equals
 *                     winning_trades / trades of THAT period: D30 9/9 = 1,
 *                     D90 9/11 = 0.8181). The board row has no win rate.
 *                     With zero trades in the period the source reports "0";
 *                     the parser keeps that undefined rate NULL, so it is
 *                     never attested.
 *   - total_positions indicators.data.trades (period trade count).
 * Not attested: max_drawdown / max_drawdown_all / pnl_all are identical for
 * D7, D30 and D90 (all-time values, e.g. a 91.8% drawdown in a 7D window with
 * zero trades), so they are not period evidence; ROI/PnL/drawdown are the
 * board's (Tier-A) evidence.
 *
 * blofin_spot declares no contract: the same endpoints serve the futures copy
 * account, so the spot board has no profile surface (index.ts supportsSurface).
 *
 * Any change to this object requires bumping @n and registering the new hash.
 */

import type { ProfileCaptureContract } from '../../profile-capture/contract'

export const BLOFIN_INDICATORS_PATH = '/uapi/v1/copy/trader/stat/indicators'

export const BLOFIN_FUTURES_PROFILE_CAPTURE: ProfileCaptureContract = {
  // Literal (not the imported constant): contract.ts imports this module for
  // its registry, so a value import back would read it before initialisation.
  document: 'arena.profile-capture-contract@1',
  captureContract: 'blofin_futures-profile-capture@1',
  sourceSlug: 'blofin_futures',
  timeframes: [7, 30, 90],
  endpoints: [
    {
      id: 'indicators',
      origin: 'https://blofin.com',
      pathname: BLOFIN_INDICATORS_PATH,
      queryAllowlist: ['stat_period', 'uid'],
      required: true,
    },
  ],
  metrics: {
    total_positions: {
      endpoint: 'indicators',
      path: ['indicators', 'data', 'trades'],
      transform: 'identity',
    },
    win_rate: {
      endpoint: 'indicators',
      path: ['indicators', 'data', 'win_ratio_all'],
      transform: 'fraction_to_percent',
    },
  },
}
