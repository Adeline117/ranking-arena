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
 * The same response carries the exchange's own per-window ROI, win rate,
 * drawdown and Sharpe, and the profile publish writes them over the board's
 * values. A board attestation survives a later write only when the value is
 * unchanged (20261116205144), so an unattested profile write of a drifted
 * drawdown would strip the board's — and drawdown is a required score input.
 * The profile therefore attests every exchange value it writes:
 *   roi      {p}YieldRateE4        pctE4  = raw / 100   (decimal_e2)
 *   win_rate {p}ProfitWinRateE4    pctE4  = raw / 100   (decimal_e2)
 *   mdd      {p}DrawDownE4         pctE4  = raw / 100   (decimal_e2, unsigned)
 *   sharpe   {p}SharpeRatioE4      e(v,4) = raw / 1e4   (decimal_e4)
 *   sortino  {p}SortinoRatioE4     e(v,4) = raw / 1e4   (decimal_e4, extras.sortino)
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
 * - copier_count: not a per-window value, and the parser falls back from
 *   pub-leader/info to leader-income (`info ?? income`), so no single
 *   declared path is the parser's source; declaring one would turn every
 *   fallback into a projection mismatch that voids the whole capture.
 * - volatility: the parser keeps {p}ReturnVolatilityE4 as extras.roe_volatility,
 *   not the publication's extras.volatility.
 */

// Type-only: contract.ts imports this module for its registry, so a value
// import would be a load-order cycle.
import type {
  ProfileCaptureContract,
  ProfileMetricFieldContract,
} from '../../profile-capture/contract'

/** leader-income field of one window: `{seven|thirty|ninety}Day<suffix>`. */
function income(
  suffix: string,
  transform: ProfileMetricFieldContract['transform']
): ProfileMetricFieldContract {
  return {
    endpoint: 'profile_bundle',
    path: [
      'income',
      'result',
      {
        byTimeframe: {
          '7': `sevenDay${suffix}`,
          '30': `thirtyDay${suffix}`,
          '90': `ninetyDay${suffix}`,
        },
      },
    ],
    transform,
  }
}

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
    roi: income('YieldRateE4', 'decimal_e2'),
    pnl: income('ProfitE8', 'decimal_e8'),
    win_rate: income('ProfitWinRateE4', 'decimal_e2'),
    mdd: income('DrawDownE4', 'decimal_e2'),
    sharpe: income('SharpeRatioE4', 'decimal_e4'),
    sortino: income('SortinoRatioE4', 'decimal_e4'),
  },
}
