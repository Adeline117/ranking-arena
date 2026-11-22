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
 * blofin_spot has its own detail endpoints and its own contract below: the
 * /uapi/v1/copy endpoints above describe the trader's FUTURES copy account,
 * also for a spot-board uid.
 *
 * Any change to a contract object requires bumping @n and registering the new
 * hash.
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

/**
 * Blofin spot Tier-B profile capture contract.
 *
 * The spot detail page (/copy-trade/details/{uid}?module=spot, Performance
 * module with a 7/30/90-day switch) reads unsigned public POST endpoints under
 * /sapi/v1/spot_copy/trader/ (public probe 2026-11-20). getProfile returns one
 * composite page per timeframe {info, indicators, symbolPerf: null,
 * performance, timeframe}, keyed by the spot stat/indicators request (uid +
 * stat_period as the URL query). parseBlofinProfile builds the timeframe's
 * only stats block from `indicators.data`.
 *
 * Attested metrics, verified per stat_period by a public probe of every trader
 * of the spot board (2026-11-20: 129 / 148 / 154 traders for D7 / D30 / D90):
 *   - win_rate        indicators.data.win_ratio_all (fraction; the period's
 *                     winning_trades / trades, e.g. D30 6/17 = 0.3529, D90
 *                     14/29 = 0.4827; stat/performance repeats it as
 *                     data.performance.win_rate). Of the 17 traders whose
 *                     trade count changes between periods, the rate changes
 *                     for 15; the other two are 2/2, 3/3, 3/3 and 0/0, 0/0,
 *                     0/1. The board row has no win rate. With zero trades in
 *                     the period the source reports "0"; the parser keeps that
 *                     undefined rate NULL, so it is never attested.
 *   - total_positions indicators.data.trades (period trade count).
 * Not attested:
 *   - max_drawdown    not a reliable period value. It differs between periods
 *                     for 29 traders, but 18 report one nonzero value for D7,
 *                     D30 and D90, and a flat window (roi 0, real_pnl 0, no
 *                     trades) still reports a nonzero drawdown in 23 of 39
 *                     (D7), 28 of 45 (D30) and 24 of 48 (D90) nonzero cases
 *                     (e.g. 64.3% in all three windows of an idle account,
 *                     fixture profile-indicators-spot-flat-*.json): a value
 *                     carried over from outside the window, like the futures
 *                     endpoint. The spot board row repeats the same number
 *                     (equal in all 431 trader-periods), so drawdown stays the
 *                     board's (Tier-A) evidence and is not attested here.
 *   - roi / pnl       the board's Tier-A evidence (real_pnl differs from the
 *                     board's pnl by the fetch lag); sharpe and the other
 *                     ratios.
 *
 * symbol_performance is not requested: the spot route answers it with code 401
 * and stat/performance already carries the per-symbol table.
 */
export const BLOFIN_SPOT_INDICATORS_PATH = '/sapi/v1/spot_copy/trader/stat/indicators'

export const BLOFIN_SPOT_PROFILE_CAPTURE: ProfileCaptureContract = {
  document: 'arena.profile-capture-contract@1',
  captureContract: 'blofin_spot-profile-capture@1',
  sourceSlug: 'blofin_spot',
  timeframes: [7, 30, 90],
  endpoints: [
    {
      id: 'indicators',
      origin: 'https://blofin.com',
      pathname: BLOFIN_SPOT_INDICATORS_PATH,
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
