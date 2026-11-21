/**
 * bitget_cfd Tier-B profile capture contract (docs/PROFILE_CAPTURE_EVIDENCE.md).
 *
 * The CFD board row carries five columns (profit_rate, total_profit,
 * total_follow_profit, aum, winning_rate) and no drawdown. The trader page
 * (/copy-trading/cfd-trader/{portfolioId}, 表现 block with a 7/30/90/180-day
 * selector) reads POST /v1/trace/mt5/public/performance {portfolioId,
 * cycleTime}: one request returns one window, so three windows are three
 * requests. Public probe 2026-11-20 (30+ traders, 7/30/90):
 *   - maxDrawDown: decimal fraction text with four places; "0.2456" is the
 *     24.56 % the page shows as 最大回撤. It is the exchange's own per-window
 *     figure and is not nested across windows (a 37-day-old portfolio reports
 *     7D 0, 30D 0.2456, 90D 0.0507), so it is stored per window as reported.
 *   - winRate: decimal fraction (0.6702 = the board's winning_rate 67.02).
 *   - roi (already percent) and profit equal the board's profit_rate and
 *     total_profit of the same window.
 *   - totalTrades: the window's trade count.
 *
 * getProfile stores details + performance as ONE page whose
 * url is the performance request with the POST body's identity (portfolioId,
 * cycleTime) as the query, so the request projection binds the portfolio and
 * the window. The portfolio belongs to the attempt's trader: getProfile
 * refuses a details response whose traderAccountId is another trader.
 *
 * All five exchange values the profile block writes are attested, not only
 * the drawdown: a profile publish replaces the row's ROI / PnL / win rate, and
 * the board attestation of a value survives only while the value is unchanged
 * (20261116205144), so on a live board an unattested profile ROI would remove
 * the board's evidence for it.
 * Not attested: copier count (details, not per window) and win rate of a
 * window without trades (the source reports 0; the parser keeps it NULL).
 *
 * bitget_spot declares no contract: its trader page shows no drawdown and
 * POST /v1/trace/spot/public/uta/performance has no maxDrawDown field for any
 * window (same probe; see __tests__/fixtures/spot-profile-capture-30.json).
 *
 * The endpoint URLs live here (not in index.ts) so the contract and the
 * request builder cannot drift apart; this module imports types only, so the
 * contract registry can load it without the worker-only adapter.
 *
 * Any change to this object requires bumping @n and registering the new hash.
 */

import type { ProfileCaptureContract } from '../../profile-capture/contract'

const ORIGIN = 'https://www.bitget.com'
const CFD_PERFORMANCE_PATH = '/v1/trace/mt5/public/performance'

/** The CFD portfolio endpoints getProfile requests (all POST, JSON body). */
export const BITGET_CFD_PROFILE_URLS = {
  details: `${ORIGIN}/v1/trace/mt5/public/details`,
  performance: `${ORIGIN}${CFD_PERFORMANCE_PATH}`,
} as const

export const BITGET_CFD_PROFILE_CAPTURE: ProfileCaptureContract = {
  // Literal (not the imported constant): contract.ts imports this module for
  // its registry, so a value import back would read it before initialisation.
  document: 'arena.profile-capture-contract@1',
  captureContract: 'bitget_cfd-profile-capture@1',
  sourceSlug: 'bitget_cfd',
  timeframes: [7, 30, 90],
  endpoints: [
    {
      id: 'performance',
      origin: ORIGIN,
      pathname: CFD_PERFORMANCE_PATH,
      queryAllowlist: ['cycleTime', 'portfolioId'],
      required: true,
    },
  ],
  metrics: {
    mdd: {
      endpoint: 'performance',
      path: ['cfdPerformance', 'data', 'maxDrawDown'],
      transform: 'fraction_to_percent',
    },
    pnl: {
      endpoint: 'performance',
      path: ['cfdPerformance', 'data', 'profit'],
      transform: 'identity',
    },
    roi: {
      endpoint: 'performance',
      path: ['cfdPerformance', 'data', 'roi'],
      transform: 'identity',
    },
    total_positions: {
      endpoint: 'performance',
      path: ['cfdPerformance', 'data', 'totalTrades'],
      transform: 'identity',
    },
    win_rate: {
      endpoint: 'performance',
      path: ['cfdPerformance', 'data', 'winRate'],
      transform: 'fraction_to_percent',
    },
  },
}
