/**
 * Bybit copyTrade classic — Tier-B profile capture contract
 * (docs/PROFILE_CAPTURE_EVIDENCE.md).
 *
 * Why: the 全部交易达人 board has ROI / win rate / drawdown / Sharpe columns
 * but NO master PnL column (parsers.ts headlinePnl: null), so the required
 * score input PnL can only come from the profile. It is the exchange's own
 * per-window value: leader-income `{sevenDay|thirtyDay|ninetyDay}ProfitE8`
 * (E8 fixed point, USDT), which parseBybitCopytradeProfile stores as
 * e(v, 8) — exactly decimal_e8.
 *
 * Surface: getProfile returns ONE bundle page per timeframe
 *   { info, income, yieldTrend, timeframe }
 * whose url is the exact per-TF dynamic-yield-trend request. Its query
 * (dayCycleType, period, leaderMark) is the request projection, so the
 * manifest binds the page to the trader and timeframe; the response hash
 * covers the whole bundle, income included (fetched in the same call with the
 * same leaderMark, never from a cross-attempt cache).
 *
 * Not attested, on purpose:
 * - total_positions: income has no per-window trade count. The parser's
 *   value is {p}WinCount + {p}LossCount, a sum Arena computes (and it does
 *   not equal the exchange's own cumTradeCount: 62 vs 15 + 50 in the
 *   2026-06-11 capture), so it is not an exchange-provided field.
 * - roi / win_rate / mdd / sharpe: the board already supplies them.
 */

// Type-only: contract.ts imports this module for its registry, so a value
// import would be a load-order cycle.
import type { ProfileCaptureContract } from '../../profile-capture/contract'

export const BYBIT_COPYTRADE_PROFILE_CAPTURE: ProfileCaptureContract = {
  document: 'arena.profile-capture-contract@1',
  captureContract: 'bybit_copytrade-profile-capture@1',
  sourceSlug: 'bybit_copytrade',
  timeframes: [7, 30, 90],
  endpoints: [
    {
      id: 'profile_bundle',
      origin: 'https://www.bybit.com',
      pathname: '/x-api/fapi/beehive/public/v2/leader/dynamic-yield-trend',
      queryAllowlist: ['dayCycleType', 'period', 'leaderMark'],
      required: true,
    },
  ],
  metrics: {
    pnl: {
      endpoint: 'profile_bundle',
      path: [
        'income',
        'result',
        {
          byTimeframe: {
            '7': 'sevenDayProfitE8',
            '30': 'thirtyDayProfitE8',
            '90': 'ninetyDayProfitE8',
          },
        },
      ],
      transform: 'decimal_e8',
    },
  },
}
