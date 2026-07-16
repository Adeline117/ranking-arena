/**
 * Declarative "should-have" metric contract per adapter (P0 of the data-
 * completeness system, 2026-07-04). See ExpectedMetrics in core/types.ts for
 * why this must be independent of ingested data (mv_source_capabilities is
 * count-derived — it measures "have", never "should have").
 *
 * DECLARATION BASIS: the emitted-metrics harvest of 2026-07-04 — every
 * adapter's parsers were run over their own RAW fixtures and the union of
 * non-null typed stats fields + board headline fields recorded. Screenshot
 * calibration (交易所细节.docx audit 2026-07-03): binance/bybit/gate/blofin/
 * bingx provide Sharpe; all five emit it here ✓.
 *
 * Central map (keyed by ADAPTER slug, one adapter may serve several
 * arena.sources rows) rather than colocated in each index.ts so the parity
 * test and the reconcile sync can read it without importing 25 heavy adapter
 * modules. SourceAdapter.expectedMetrics stays available for future
 * colocation.
 *
 * RULES for editing:
 *  - Adding a metric: the parity test must prove the parsers emit it over
 *    fixtures (add/refresh a fixture if needed) — never declare on faith.
 *  - Removing a metric: only with an upstream-discontinued verdict recorded
 *    in docs/UNREACHABLE_FIELDS_LEDGER.md.
 *  - New adapter: declare here + fixtures covering every declared metric
 *    (docs/ADAPTER_ONBOARDING.md).
 */

import type { ExpectedMetrics } from '../core/types'

/**
 * Per-SOURCE overrides for multi-source adapters whose variants provide
 * different metric sets (first carpet-audit findings, 2026-07-04):
 * the adapter-level declaration is the futures/main variant; spot/cfd
 * variants that lack profile trade-counts etc. override here.
 * Sync precedence: BY_SOURCE[slug] > EXPECTED_METRICS[adapter_slug].
 */
export const EXPECTED_METRICS_BY_SOURCE: Record<string, ExpectedMetrics> = {
  // spot profile provides no trade counts (prod 0/8103 both)
  binance_spot: [
    'roi',
    'pnl',
    'sharpe',
    'mdd',
    'win_rate',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
  ],
  // cfd variant has no volume surface (prod 0/10523)
  gate_cfd: [
    'roi',
    'pnl',
    'sharpe',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
  ],
  // spot board-only in practice: no profile crawl upstream → profile-only
  // metrics (win/total positions, copier_pnl, aum, holding) never fill
  xt_spot: ['roi', 'pnl', 'mdd', 'win_rate', 'copier_count'],
}

export const EXPECTED_METRICS: Record<string, ExpectedMetrics> = {
  binance: [
    'roi',
    'pnl',
    'sharpe',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
  ],
  // Tier-A-only (board headline; profile parsers throw by design)
  binance_web3: ['roi', 'pnl', 'win_rate', 'volume'],
  // board-only source (profile:false) — all metrics from the board superset
  bingx: ['roi', 'pnl', 'sharpe', 'mdd', 'win_rate', 'copier_pnl', 'copier_count', 'aum'],
  // Tier-A-only; volume joins from the vol board (subset of rows)
  bitfinex: ['pnl', 'volume'],
  bitget: [
    'roi',
    'pnl',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
    'holding_duration_avg',
  ],
  bitget_bots: ['roi', 'pnl', 'mdd', 'copier_pnl', 'copier_count', 'aum'],
  bitmart: [
    'roi',
    'pnl',
    'mdd',
    'win_rate',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
    'holding_duration_avg',
  ],
  bitunix: [
    'roi',
    'pnl',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
  ],
  blofin: [
    'roi',
    'pnl',
    'sharpe',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_count',
    'aum',
    'volume',
  ],
  btcc: [
    'roi',
    'pnl',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_count',
    'aum',
    'profit_share_rate',
    'holding_duration_avg',
  ],
  bybit_copytrade: [
    'roi',
    'pnl',
    'sharpe',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
    'holding_duration_avg',
  ],
  bybit_mt5: [
    'roi',
    'pnl',
    'sharpe',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
    'holding_duration_avg',
  ],
  coinex: [
    'roi',
    'pnl',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
  ],
  gate: [
    'roi',
    'pnl',
    'sharpe',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'volume',
    'profit_share_rate',
  ],
  // Canonical GMX PnL is realized-net. Its available history is total
  // mark-to-market, so risk derived from that mixed basis is honest-NULL.
  gmx: ['roi', 'pnl', 'win_rate', 'win_positions', 'total_positions', 'aum', 'volume'],
  // roi null by design (no capital basis); mdd honest-NULL; Tier-0 risk needs
  // ≥7 daily deltas which the real fixture lacks — see harvest notes.
  gtrade: ['pnl', 'win_rate', 'win_positions', 'total_positions'],
  htx: [
    'roi',
    'pnl',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
    'holding_duration_avg',
  ],
  // win_rate/holding_duration_avg need a REAL fills fixture (fills replay);
  // fills:[] emits explicit-0 positions but 0/0 win_rate stays null. Fixture
  // gap tracked — extend the declaration when a fills fixture lands.
  hyperliquid: ['roi', 'pnl', 'sharpe', 'mdd', 'win_positions', 'total_positions', 'aum', 'volume'],
  kucoin: ['roi', 'pnl', 'copier_pnl', 'copier_count', 'aum', 'profit_share_rate'],
  lbank: [
    'roi',
    'pnl',
    'mdd',
    'win_rate',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
  ],
  mexc: [
    'roi',
    'pnl',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'profit_share_rate',
    'holding_duration_avg',
  ],
  // win/loss reported as DAYS (extras), not positions
  okx: ['roi', 'pnl', 'win_rate', 'copier_pnl', 'copier_count', 'aum'],
  // aum deliberately null (SOL balance → extras.native_balance_usd)
  okx_web3: ['roi', 'pnl', 'win_rate', 'volume'],
  phemex: [
    'roi',
    'pnl',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'volume',
    'profit_share_rate',
    'holding_duration_avg',
  ],
  toobit: ['roi', 'pnl', 'sharpe', 'mdd', 'win_rate', 'copier_count', 'aum', 'profit_share_rate'],
  xt: [
    'roi',
    'pnl',
    'mdd',
    'win_rate',
    'win_positions',
    'total_positions',
    'copier_pnl',
    'copier_count',
    'aum',
    'holding_duration_avg',
  ],
}
